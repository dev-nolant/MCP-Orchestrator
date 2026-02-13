/**
 * Ensures user args are always in a valid form for MCP callTool.
 * MCP expects `arguments` to be Record<string, unknown>.
 *
 * If the user provides a primitive, array, or null, we wrap it in a standard key
 * so every MCP receives a proper object. Tools that accept a single string/input
 * typically use keys like "input", "content", "query", or "text" - we use "input"
 * as a generic fallback.
 */
export function ensureArgsObject(raw) {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw;
    }
    return { input: raw };
}
