import { Request, Response, NextFunction } from 'express';

interface AuthenticatedUser {
  userId: string;
  email: string;
  roles: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const userId = req.headers['x-user-id'] as string;
  const email = req.headers['x-user-email'] as string;
  const roles = req.headers['x-user-roles'] as string;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  req.user = {
    userId,
    email: email || '',
    roles: roles ? roles.split(',') : [],
  };

  next();
};

export const requirePermission = (...permissions: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const hasPermission = permissions.some((permission) =>
      req.user!.roles.includes(permission) || req.user!.roles.includes('admin')
    );

    if (!hasPermission) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
};

export const optionalAuth = (req: Request, res: Response, next: NextFunction): void => {
  const userId = req.headers['x-user-id'] as string;
  const email = req.headers['x-user-email'] as string;
  const roles = req.headers['x-user-roles'] as string;

  if (userId) {
    req.user = {
      userId,
      email: email || '',
      roles: roles ? roles.split(',') : [],
    };
  }

  next();
};
