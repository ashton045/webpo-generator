import { fetch_pot } from '../../botguard.js';
import { getVisitorData } from './visitor.js';

export async function generate(contentBinding, visitorTtl, requestTimeout) {
    return fetch_pot(contentBinding || await getVisitorData(visitorTtl, requestTimeout));
}
