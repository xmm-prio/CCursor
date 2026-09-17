/**
 * aiserver.v1.BidiService — Bidi 辅助服务
 *
 * 1 方法:
 *   - BidiAppend (unary) — 向 bidi 流追加消息
 *     SSE 降级模式下，客户端通过此方法发送 AgentClientMessage，
 *     data 字段包含 base64 编码的序列化 protobuf，requestId 关联到 RunSSE 流。
 *
 * Transport: backendUrl (api2.cursor.sh)
 */
import type { ConnectRouter } from '@connectrpc/connect';
import { BidiService } from '../../gen/aiserver_v1_pb';
import { appendMessage } from '../../handlers/agent/session';
import { logger } from '../../logger';

export default (router: ConnectRouter) => {
    router.service(BidiService, {
        bidiAppend: async (req) => {
            const requestId = req.requestId?.requestId;
            if (requestId && req.data) {
                // debug, not info: a chatty shell streams hundreds of appends per turn,
                // and every one of them would otherwise be pushed to the window SSE log.
                logger.debug({ requestId, dataLen: req.data.length, seqno: Number(req.appendSeqno) }, '[SVC] BidiAppend');
                appendMessage(requestId, req.data, req.appendSeqno);
            } else {
                logger.warn({ hasRequestId: !!requestId, hasData: !!req.data }, '[SVC] BidiAppend missing fields');
            }
            return {};
        },
    });
};
