export function validateGeneration(body) {
    if(!body || typeof body !== 'object' || Array.isArray(body))
        return 'request body must be a JSON object';

    if(body.content_binding !== undefined && (typeof body.content_binding !== 'string' || body.content_binding.length === 0))
        return 'content_binding must be a non-empty string when provided';

    if(body.content_binding?.length > 8192)
        return 'content_binding is too long';

    if(body.coldToken !== undefined && typeof body.coldToken !== 'boolean')
        return 'coldToken must be a boolean when provided';

    return;
}

export function validateColdStartDecode(body) {
    if(!body || typeof body !== 'object' || Array.isArray(body))
        return 'request body must be a JSON object';

    if(typeof body?.token !== 'string' || body?.token?.length === 0)
        return 'token must be a non-empty string';

    if(body?.token?.length > 4096)
        return 'token is too long';

    return;
}
