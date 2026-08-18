import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(req, token) {

    if(typeof token !== 'string' || !token?.length)
        return false;

    const authorization = req?.headers?.authorization;

    if(typeof authorization !== 'string')
        return false;

    const expected = Buffer.from(token);
    const received = Buffer.from(authorization);

    return expected?.length === received?.length && timingSafeEqual(expected, received);
    
}
