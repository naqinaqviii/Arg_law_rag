import { API_BASE_URL } from "./config.ts";

const API_BASE = `${API_BASE_URL}/usermanagement/api/auth`;

export interface LoginResponse {
    token: string;
    refreshToken: string;
    expiration: string;
    user: {
        id: string;
        email: string;
        roles: string[];
        status: string;
        hasPaidRegistrationFee: boolean;
        isEmailVerified: boolean;
        isPhoneVerified: boolean;
        phoneNumber?: string;
        amount?: string;
        [key: string]: unknown;
    };
}

export interface RegisterResponse {
    message: string;
    userId: string;
}

async function parseErrorResponse(res: Response): Promise<string> {
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        try {
            const json = await res.json();
            return json?.message || json?.detail || JSON.stringify(json) || res.statusText;
        } catch {
            return res.statusText || "Request failed";
        }
    }
    return res.statusText || "Request failed";
}

export const loginUser = async (email: string, password: string, productid = 0) => {
    try {
        const res = await fetch(`${API_BASE}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ Email: email, Password: password, productid }),
        });

        if (!res.ok) {
            const msg = await parseErrorResponse(res);
            throw new Error(msg);
        }

        return (await res.json()) as LoginResponse;
    } catch (error: unknown) {
        throw new Error("Login failed", { cause: error });
    }
};

export const registerUser = async (formData: FormData) => {
    try {
        const res = await fetch(`${API_BASE}/register`, {
            method: "POST",
            body: formData,
        });

        if (!res.ok) {
            const msg = await parseErrorResponse(res);
            throw new Error(msg);
        }

        return (await res.json()) as RegisterResponse;
    } catch (error: unknown) {
        throw new Error("Registration failed", { cause: error });
    }
};

export const requestPasswordReset = async (email: string) => {
    try {
        const res = await fetch(`${API_BASE}/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
        });

        if (!res.ok) {
            const msg = await parseErrorResponse(res);
            throw new Error(msg);
        }

        return await res.json();
    } catch (error: unknown) {
        throw new Error("Failed to send reset code. Please try again.", { cause: error });
    }
};

export const verifyResetCode = async (email: string, code: string) => {
    try {
        const res = await fetch(`${API_BASE}/verify-reset-code`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, code }),
        });

        if (!res.ok) {
            const msg = await parseErrorResponse(res);
            throw new Error(msg);
        }

        return await res.json();
    } catch (error: unknown) {
        throw new Error("Invalid or expired verification code.", { cause: error });
    }
};

export const resetPassword = async (payload: { email: string; code: string; newPassword: string }) => {
    try {
        const res = await fetch(`${API_BASE}/reset-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const msg = await parseErrorResponse(res);
            throw new Error(msg);
        }

        return await res.json();
    } catch (error: unknown) {
        throw new Error("Failed to reset password. The code might be invalid or expired.", { cause: error });
    }
};
