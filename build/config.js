/** Normalize a value to a valid DNS subdomain (lowercase, alphanumeric and hyphens). */
export function toTunnelSubdomain(name, config) {
    const override = config && 'tunnelSubdomain' in config ? config.tunnelSubdomain : undefined;
    const raw = (typeof override === 'string' && override.trim()) ? override.trim() : name;
    return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || 'mcp';
}
