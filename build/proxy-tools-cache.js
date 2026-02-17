export let proxyToolsCache = null;
export function setProxyToolsCache(tools) {
    proxyToolsCache = tools;
}
export function invalidateProxyToolsCache() {
    proxyToolsCache = null;
}
