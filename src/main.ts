import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Determine allowed origins based on NODE_ENV
  const allowedOrigins =
    process.env.NODE_ENV === 'production'
      ? ['https://trymidas.fun']
      : [
          'http://localhost:3000',
          'https://testing.trymidas.fun',
          'https://trymidas.fun',
        ];

  app.enableCors({
    origin: allowedOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  await app.listen(process.env.PORT || 8080, '0.0.0.0');
}
bootstrap();
