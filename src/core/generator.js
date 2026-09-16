import { fetch_pot } from '../../botguard.js';
import { getVisitorData } from './visitor.js';

export async function generate(contentBinding, ttl, timeout) {
    const isExplicit = typeof contentBinding === 'string' && contentBinding.trim().length > 0;
    const binding = isExplicit ? contentBinding.trim() : await getVisitorData(ttl, timeout);
    const ttl_to_use = isExplicit ? ttl : (ttl || 10 * 60 * 1000);
    return fetch_pot(binding, true, ttl_to_use);
}
