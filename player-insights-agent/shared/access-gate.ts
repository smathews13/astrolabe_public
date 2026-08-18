/**
 * Whether the access check is asked for before the app opens.
 *
 * Off. The component, its route and its tests are kept intact because the check
 * may be wanted again; while this is false nothing may record a mode for it,
 * or a session nobody was asked about would read afterwards as one that
 * declined.
 *
 * Here rather than in `experimental-features.ts` because that file is a
 * per-browser preference the server never reads, and this is deployment state
 * the server has to agree with.
 */
export const ACCESS_GATE_ENABLED: boolean = false;
