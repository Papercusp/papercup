/**
 * P006 integration entry for the SAME dispatcher matrix. Its P006 cases use
 * actual HTTP and authenticated UDS sockets; older cases explicitly identify
 * captured HTTP handlers or in-memory SDK transports. Reusing the source keeps
 * registry/auth/persistence seams identical instead of forking 200+ mock lines.
 *
 * This is a second runner-layer receipt, NOT independent implementation or
 * production-PG authentication evidence. The unit entry remains in the normal
 * gate so established policy regressions never lose their existing coverage.
 */
import './mcp-handler-gating-matrix.test';
