import { API_PATHS, GLOBAL_ROOM_ID } from "../../../../packages/shared/protocol";
function isApiFailure(payload) {
    return payload.ok === false;
}
async function parseResponse(response) {
    let payload;
    try {
        payload = (await response.json());
    }
    catch {
        throw new Error("服务返回了非 JSON 响应");
    }
    if (!response.ok || isApiFailure(payload)) {
        const message = isApiFailure(payload) ? payload.error.message : "请求失败";
        throw new Error(message);
    }
    return payload;
}
export class ChatApi {
    baseUrl;
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }
    async createSession(nickname) {
        const response = await fetch(`${this.baseUrl}${API_PATHS.session}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ nickname })
        });
        const payload = await parseResponse(response);
        return payload.data;
    }
    async getMessages(token, options) {
        const query = new URLSearchParams();
        query.set("room", GLOBAL_ROOM_ID);
        if (options?.cursor) {
            query.set("cursor", options.cursor);
        }
        if (options?.limit) {
            query.set("limit", String(options.limit));
        }
        const response = await fetch(`${this.baseUrl}${API_PATHS.messages}?${query.toString()}`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
        const payload = await parseResponse(response);
        return payload.data;
    }
    async getMessagesAfter(token, afterTimestamp) {
        const query = new URLSearchParams();
        query.set("room", GLOBAL_ROOM_ID);
        query.set("after", String(afterTimestamp));
        const response = await fetch(`${this.baseUrl}${API_PATHS.messages}?${query.toString()}`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
        const payload = await parseResponse(response);
        return payload.data;
    }
}
