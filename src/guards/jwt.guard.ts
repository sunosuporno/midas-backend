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
    console.log('🔐 Initializing Crossmint Auth Guard...');
    const crossmint = createCrossmint({
      apiKey: process.env.CROSSMINT_SERVER_API_KEY,
    });
    this.crossmintAuth = CrossmintAuth.from(crossmint);
    console.log('✅ Crossmint Auth Guard initialized');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    console.log('\n=== Processing Authentication Request ===');
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      console.log('❌ No authorization header found');
      throw new UnauthorizedException('No authorization header');
    }

    try {
      console.log('🔍 Extracting token from header...');
      const token = authHeader.split(' ')[1];
      console.log('Token:', token.substring(0, 20) + '...');

      // Check if JWT is expired before verifying
      if (isJwtExpired(token)) {
        console.log('❌ JWT expired');
        throw new UnauthorizedException('Token expired');
      }

      console.log('🔐 Verifying Crossmint JWT...');
      const decodedJwt = this.crossmintAuth.verifyCrossmintJwt(token);

      if (!decodedJwt) {
        console.log('❌ JWT verification failed - invalid token');
        throw new UnauthorizedException('Invalid token');
      }

      console.log('✅ JWT verified successfully');

      // Store the decoded JWT in request for later use
      request.user = decodedJwt;

      console.log('=== Authentication Complete ===\n');
      return true;
    } catch (error) {
      console.error('\n❌ Token verification failed');
      console.error('Error details:', error);
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
