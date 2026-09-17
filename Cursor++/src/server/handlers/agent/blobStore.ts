/**
 * Blob Store — Server 端 blob 缓存
 *
 * 双层存储:
 *   1. 内存 Map (主要路径) — 同步读写，保证 generator/hot path 无阻塞
 *   2. SQLite (持久化) — 异步写入，启动时预热
 *
 * Server 每次发出 setBlobArgs 时，同时缓存 blob 内容。
 * 下一轮 Client 带回 blob IDs 时，Server 直接从内存缓存读取，
 * 无需通过 getBlobArgs 握手向 Client 取回。
 *
 * SSE 降级模式下 getBlobArgs 握手不可靠（Server 无法在 yield 中间等待 Client 回传），
 * 因此 Server 端缓存是必要的。
 *
 * ## 为什么缓存自己管上界
 *
 * 一个 blob 是一条消息的 base64 JSON —— 一次 grep 或整文件 Read 的结果可以是
 * 几 MB。这个 Map 由整机所有窗口的所有会话共用（BYOK server 全机唯一），
 * 只增不减的话，长时间多窗口使用就是一条无上界的内存曲线，而承载它的是
 * extension host 进程，不是一个可以随便吃内存的独立服务。
 *
 * 淘汰之所以安全，是因为每条 blob 同时写进了 sqlite: 未命中的一方
 * (warmupBlobsAsync) 会把它读回来。所以上界由本模块在写入时自己维持，
 * 而不是交给某个调用方记得去定期清理 —— 那种约定此前就从来没有人遵守。
 */
import { logger } from '../../logger';
import { loadPersistedBlob, persistBlob } from '../../database/blobs';

/**
 * 条目数上界。
 *
 * 只作为极端小 blob 场景下的兜底 —— 正常情况下先触顶的是字节上界。
 */
export const BLOB_CACHE_MAX_ENTRIES = 20_000;

/**
 * 字节上界 (以 base64 字符串长度近似计)。
 *
 * 128 MiB: 足以让数千条近期 blob 常驻内存（命中率才是这层缓存的全部价值），
 * 又远低于 extension host 里一个组件可以正当占用的量级。
 */
export const BLOB_CACHE_MAX_BYTES = 128 * 1024 * 1024;

/**
 * blobId → blobData (base64)。
 *
 * Map 的插入顺序即 LRU 顺序: 命中时 delete + set 把条目挪到队尾，
 * 淘汰时从队首取最久未用的。
 */
const blobCache = new Map<string, string>();

let cachedBytes = 0;
let evictedEntries = 0;

/**
 * 把缓存压回上界之内。写入路径调用，摊还成本为 O(被淘汰条目数)。
 */
function evictToBudget(): void {
    if (blobCache.size <= BLOB_CACHE_MAX_ENTRIES && cachedBytes <= BLOB_CACHE_MAX_BYTES)
        return;

    const before = blobCache.size;
    for (const [id, data] of blobCache) {
        if (blobCache.size <= BLOB_CACHE_MAX_ENTRIES && cachedBytes <= BLOB_CACHE_MAX_BYTES)
            break;
        blobCache.delete(id);
        cachedBytes -= data.length;
        evictedEntries++;
    }
    logger.debug({
        evicted: before - blobCache.size,
        remaining: blobCache.size,
        bytes: cachedBytes,
    }, '[SESSION] blob cache evicted to budget');
}

function store(blobId: string, blobData: string): void {
    const previous = blobCache.get(blobId);
    if (previous !== undefined) {
        cachedBytes -= previous.length;
        blobCache.delete(blobId);
    }
    blobCache.set(blobId, blobData);
    cachedBytes += blobData.length;
    evictToBudget();
}

/**
 * 同步写内存缓存 + fire-and-forget 持久化到 DB。
 * 调用方无需 await，DB 失败仅记录日志不中断流程。
 */
export function cacheBlob(blobId: string, blobData: string): void {
    store(blobId, blobData);
    persistBlob(blobId, blobData).catch(err => {
        logger.warn({ blobId, error: (err as Error).message }, '[SESSION] persistBlob failed (continuing)');
    });
}

/**
 * 同步从内存缓存读取，并把命中条目刷新为最近使用。
 * 若 miss，返回 undefined — 调用方应在进入 hot path 前先调用 warmupBlobsAsync 预热。
 */
export function getCachedBlob(blobId: string): string | undefined {
    const data = blobCache.get(blobId);
    if (data === undefined)
        return undefined;
    blobCache.delete(blobId);
    blobCache.set(blobId, data);
    return data;
}

/**
 * 异步预热: 从 DB 加载指定 blobs 到内存缓存。
 * 应在进入 generator/hot path 之前调用一次，确保后续 getCachedBlob 同步命中。
 */
export async function warmupBlobsAsync(blobIds: string[]): Promise<void> {
    const missing = blobIds.filter(id => !blobCache.has(id));
    if (missing.length === 0) return;

    await Promise.all(missing.map(async id => {
        try {
            const data = await loadPersistedBlob(id);
            if (data !== undefined) {
                store(id, data);
            }
        } catch (err) {
            logger.warn({ blobId: id, error: (err as Error).message }, '[SESSION] warmupBlob failed');
        }
    }));
}

/** 从缓存获取多个 blob，返回解码后的 JSON 对象数组 */
export function getCachedBlobsAsMessages(blobIds: string[]): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    if (blobIds.length > 0) {
        const cacheKeys = [...blobCache.keys()].slice(0, 3);
        logger.debug({ requestedFirst: blobIds[0], cacheKeySamples: cacheKeys, cacheSize: blobCache.size }, '[SESSION] blob cache lookup');
    }
    for (const id of blobIds) {
        const data = getCachedBlob(id);
        if (data) {
            try {
                const json = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'));
                messages.push(json);
            } catch (e) {
                logger.warn({ blobId: id, error: (e as Error).message }, '[SESSION] failed to decode cached blob');
            }
        } else {
            logger.debug({ blobId: id }, '[SESSION] blob not in cache');
        }
    }
    return messages;
}

/** Live view of the cache, for /byok/debug. */
export function blobCacheDiagnostics(): {
    entries: number;
    bytes: number;
    maxEntries: number;
    maxBytes: number;
    evictedEntries: number;
} {
    return {
        entries: blobCache.size,
        bytes: cachedBytes,
        maxEntries: BLOB_CACHE_MAX_ENTRIES,
        maxBytes: BLOB_CACHE_MAX_BYTES,
        evictedEntries,
    };
}

export function resetBlobCacheForTests(): void {
    blobCache.clear();
    cachedBytes = 0;
    evictedEntries = 0;
}
