/**
 * Blob cache budget.
 *
 * The cache is shared by every conversation of every window, and its entries
 * are whole messages — a file read or a grep result can be megabytes. These
 * tests pin the two properties that keep it from growing without bound in a
 * process that also hosts the editor: it evicts on write, and it evicts the
 * least recently *used* entry rather than the oldest one written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BLOB_CACHE_MAX_BYTES,
  BLOB_CACHE_MAX_ENTRIES,
  blobCacheDiagnostics,
  cacheBlob,
  getCachedBlob,
  resetBlobCacheForTests,
} from '../handlers/agent/blobStore'

// The store persists every blob behind the cache; eviction is only safe
// because of that, and the DB is not what these tests are about.
vi.mock('../database/blobs', () => ({
  persistBlob: () => Promise.resolve(),
  loadPersistedBlob: () => Promise.resolve(undefined),
}))

beforeEach(() => {
  resetBlobCacheForTests()
})

describe('byte budget', () => {
  it('evicts until the cache is back under the byte ceiling', () => {
    const oneMiB = 'x'.repeat(1024 * 1024)
    const blobCount = BLOB_CACHE_MAX_BYTES / oneMiB.length + 8

    for (let i = 0; i < blobCount; i++)
      cacheBlob(`blob-${i}`, oneMiB)

    const stats = blobCacheDiagnostics()
    expect(stats.bytes).toBeLessThanOrEqual(BLOB_CACHE_MAX_BYTES)
    expect(stats.evictedEntries).toBeGreaterThan(0)
    expect(getCachedBlob('blob-0')).toBeUndefined()
    expect(getCachedBlob(`blob-${blobCount - 1}`)).toBe(oneMiB)
  })

  it('does not double-count an overwritten blob', () => {
    cacheBlob('same-id', 'a'.repeat(1000))
    cacheBlob('same-id', 'b'.repeat(10))

    expect(blobCacheDiagnostics()).toMatchObject({ entries: 1, bytes: 10 })
    expect(getCachedBlob('same-id')).toBe('b'.repeat(10))
  })
})

describe('recency', () => {
  it('keeps the entry that was read most recently, not the one written last', () => {
    const oneMiB = 'x'.repeat(1024 * 1024)
    const blobCount = BLOB_CACHE_MAX_BYTES / oneMiB.length

    for (let i = 0; i < blobCount; i++)
      cacheBlob(`blob-${i}`, oneMiB)

    // Touch the oldest entry, then push the cache one blob over the ceiling.
    expect(getCachedBlob('blob-0')).toBe(oneMiB)
    cacheBlob('newcomer', oneMiB)

    expect(getCachedBlob('blob-0')).toBe(oneMiB)
    expect(getCachedBlob('blob-1')).toBeUndefined()
  })
})

describe('entry budget', () => {
  it('bounds the entry count even when every blob is tiny', () => {
    for (let i = 0; i < BLOB_CACHE_MAX_ENTRIES + 50; i++)
      cacheBlob(`tiny-${i}`, 'v')

    expect(blobCacheDiagnostics().entries).toBeLessThanOrEqual(BLOB_CACHE_MAX_ENTRIES)
  })
})
