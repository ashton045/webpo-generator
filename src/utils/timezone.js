import ct from 'countries-and-timezones';

export function resolveTimezoneForCountry(gl) {
    if (typeof gl !== 'string' || !gl.trim()) return null;
    const code = gl.trim().toUpperCase();
    const country = ct.getCountry?.(code) || ct.default?.getCountry?.(code);
    if (country?.timezones?.length) {
        return country.timezones[0];
    }
    try {
        const locale = new Intl.Locale(`und-${code}`);
        const zones = locale.getTimeZones?.() || locale.timeZones;
        if (Array.isArray(zones) && zones.length > 0) {
            return zones[0];
        }
    } catch { }
    return null;
}
