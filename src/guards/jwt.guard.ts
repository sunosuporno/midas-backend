import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { createCrossmint, CrossmintAuth } from '@crossmint/server-sdk';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { jwtDecode } from 'jwt-decode';

@Injectable()
export class CrossmintJwtGuard implements CanActivate {
  private crossmintAuth: CrossmintAuth;

  constructor(private reflector: Reflector) {
    const crossmint = createCrossmint({
      apiKey: process.env.CROSSMINT_SERVER_API_KEY,
    });
    this.crossmintAuth = CrossmintAuth.from(crossmint);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('No authorization header');
    }

    try {
      const token = authHeader.split(' ')[1];

      // Check if JWT is expired before verifying
      if (isJwtExpired(token)) {
        throw new UnauthorizedException('Token expired');
      }

      const decodedJwt = this.crossmintAuth.verifyCrossmintJwt(token);

      if (!decodedJwt) {
        throw new UnauthorizedException('Invalid token');
      }

      // Store the decoded JWT in request for later use
      request.user = decodedJwt;

      return true;
    } catch (error) {
      // If the error is already an UnauthorizedException, rethrow it
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid token');
    }
  }
}

function isJwtExpired(token) {
  const { exp } = jwtDecode(token) as { exp: number };
  return Date.now() >= exp * 1000;
}
