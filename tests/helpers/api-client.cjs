function apiClient(baseUrl, token) {
  async function request(path, options = {}) {
    const response = await fetch(new URL(path, baseUrl), {
      ...options,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
    });
    const body = await response.json().catch(() => ({}));
    return { body, requestId: response.headers.get("x-request-id"), status: response.status };
  }
  return { request };
}

module.exports = { apiClient };
