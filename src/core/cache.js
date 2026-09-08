export function createCache(max_size, ttl) {

    const values = new Map();
    const cleanupTimer = setInterval(remove, Math.min(Math.max(ttl, 1000), 60000));

    cleanupTimer.unref();

    function remove() {
        const now = Date.now();

        for(const [k, entry] of values) {
            if (entry.expires <= now)
                values.delete(k);
        }
    }

    return {

        get(key) {

            remove();

            const entry = values.get(key);
            if (!entry) return;

            values.delete(key);
            values.set(key, entry);

            return entry.value;
        },

        set(key, value, tt) {
            const t = tt || ttl;
            if (max_size <= 0 || t <= 0) return;

            remove();

            values.delete(key);
            values.set(key, { value, expires: Date.now() + t });

            while (values.size > max_size)
                values.delete(values.keys().next().value);
        },

        delete(key) {
            return values.delete(key);
        },

        clear() {
            values.clear();
        },

        close() {
            clearInterval(cleanupTimer);
        },

        get size() {
            remove();
            return values.size;
        }
    }
}
