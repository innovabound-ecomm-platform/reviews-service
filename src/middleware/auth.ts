import { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify, errors, JWTPayload } from "jose";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email?: string;
    roles?: string[];
    permissions?: string[];
    sessionId?: string;
  };
  userId?: string;
}

// JWT Configuration
const ISSUER = "auth-service";
const AUDIENCE = "ecomm-platform";
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "http://localhost:8003";

// JWKS remote set (fetches and caches keys automatically)
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Get or create the JWKS remote set
 */
function getJWKS() {
  if (!jwks) {
    const jwksUrl = new URL(`${AUTH_SERVICE_URL}/auth/.well-known/jwks.json`);
    jwks = createRemoteJWKSet(jwksUrl);
  }
  return jwks;
}

interface TokenPayload extends JWTPayload {
  sub: string;
  email: string;
  roles: string[];
  permissions: string[];
  sessionId?: string;
}

/**
 * Verify access token and return payload
 */
async function verifyAccessToken(token: string): Promise<{
  sub: string;
  email: string;
  roles: string[];
  permissions: string[];
  sessionId?: string;
} | null> {
  try {
    const { payload } = await jwtVerify<TokenPayload>(token, getJWKS(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    return {
      sub: payload.sub,
      email: payload.email || "",
      roles: payload.roles || [],
      permissions: payload.permissions || [],
      sessionId: payload.sessionId,
    };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      console.log("Access token expired");
    } else {
      console.log("JWT verification failed");
    }
    return null;
  }
}

/**
 * Middleware to verify user is authenticated
 * Supports both header-based auth (from gateway) and JWT cookie auth (direct calls)
 */
export const requireAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  // Method 1: Header-based auth (from API gateway)
  const userId = req.headers["x-user-id"] as string;
  const userEmail = req.headers["x-user-email"] as string;
  const userRoles = req.headers["x-user-roles"] as string;

  if (userId) {
    req.user = {
      id: userId,
      email: userEmail,
      roles: userRoles ? userRoles.split(",") : [],
    };
    req.userId = userId;
    return next();
  }

  // Method 2: JWT from cookie (direct browser calls)
  const cookieToken = req.cookies?.access_token;
  if (cookieToken) {
    const payload = await verifyAccessToken(cookieToken);
    if (payload) {
      req.user = {
        id: payload.sub,
        email: payload.email,
        roles: payload.roles,
        permissions: payload.permissions,
        sessionId: payload.sessionId,
      };
      req.userId = payload.sub;
      return next();
    }
  }

  // Method 3: Bearer token in Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const payload = await verifyAccessToken(token);
    if (payload) {
      req.user = {
        id: payload.sub,
        email: payload.email,
        roles: payload.roles,
        permissions: payload.permissions,
        sessionId: payload.sessionId,
      };
      req.userId = payload.sub;
      return next();
    }
  }

  return res.status(401).json({ error: "Authentication required" });
};

/**
 * Middleware to check if user has required permission
 */
export const requirePermission = (permission: string) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const userRoles = req.user?.roles || [];
    const userPermissions = req.user?.permissions || [];

    // Admin/Super Admin roles have all permissions
    if (userRoles.some(role => ["ADMIN", "SUPER_ADMIN", "STAFF", "admin"].includes(role))) {
      return next();
    }

    // Check explicit permission
    if (userPermissions.includes(permission)) {
      return next();
    }

    // Check role-based permission (legacy format)
    const hasPermission = userRoles.some(role =>
      role === permission || role.startsWith(`${permission.split(":")[0]}:`)
    );

    if (!hasPermission) {
      return res.status(403).json({ error: "Insufficient permissions", required: permission });
    }

    next();
  };
};

/**
 * Middleware to require admin role
 */
export const requireAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const userRoles = req.user?.roles || [];

  if (userRoles.some(role => ["ADMIN", "SUPER_ADMIN", "STAFF", "admin"].includes(role))) {
    return next();
  }

  return res.status(403).json({ error: "Admin access required" });
};

/**
 * Optional auth - populates user if present but doesn't require it
 */
export const optionalAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  // Try header-based auth
  const userId = req.headers["x-user-id"] as string;
  const userEmail = req.headers["x-user-email"] as string;
  const userRoles = req.headers["x-user-roles"] as string;

  if (userId) {
    req.user = {
      id: userId,
      email: userEmail,
      roles: userRoles ? userRoles.split(",") : [],
    };
    req.userId = userId;
    return next();
  }

  // Try JWT from cookie
  const cookieToken = req.cookies?.access_token;
  if (cookieToken) {
    const payload = await verifyAccessToken(cookieToken);
    if (payload) {
      req.user = {
        id: payload.sub,
        email: payload.email,
        roles: payload.roles,
        permissions: payload.permissions,
        sessionId: payload.sessionId,
      };
      req.userId = payload.sub;
      return next();
    }
  }

  // Try Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const payload = await verifyAccessToken(token);
    if (payload) {
      req.user = {
        id: payload.sub,
        email: payload.email,
        roles: payload.roles,
        permissions: payload.permissions,
        sessionId: payload.sessionId,
      };
      req.userId = payload.sub;
    }
  }

  next();
};
