export function isAuthorized(request, token) {
    return !token || request.headers.authorization === token;
}
