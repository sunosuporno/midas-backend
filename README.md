<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://coveralls.io/github/nestjs/nest?branch=master" target="_blank"><img src="https://coveralls.io/repos/github/nestjs/nest/badge.svg?branch=master#9" alt="Coverage" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).

# Midas Backend

A NestJS backend service for managing Aerodrome LP positions and automated rebalancing.

## Features

- **Aerodrome LP Position Management**: Create, monitor, and manage liquidity positions
- **Automated Rebalancing**: Intelligent rebalancing based on multiple conditions
- **Multi-DEX Support**: 0x API with 1inch fallback for token swaps
- **Crossmint Integration**: Secure wallet management and transaction execution
- **Real-time Monitoring**: Position tracking and fee collection

## Environment Variables

### Required Variables

```env
# Crossmint Configuration
CROSSMINT_SERVER_API_KEY=your_crossmint_api_key
WALLET_SIGNER_SECRET_KEY=your_signer_private_key
SIGNER_WALLET=your_signer_wallet_address

# Blockchain Configuration
ALCHEMY_API_KEY_BASE=your_alchemy_base_api_key

# DEX API Keys (at least one required)
ZEROX_API_KEY=your_0x_api_key
ONEINCH_API_KEY=your_1inch_api_key

# Database
MONGODB_URI=your_mongodb_connection_string
```

### DEX Integration

The service supports multiple DEX aggregators for token swaps:

- **0x API** (Primary): Used as the first choice for swaps
- **1inch API** (Fallback): Automatically used if 0x fails

Both APIs are used for:

- Getting swap quotes
- Executing token swaps
- Price discovery

The system will automatically try 0x first, then fall back to 1inch if 0x fails, ensuring high availability for swap operations.

## API Endpoints

### Core Endpoints

- `POST /aerodrome/mint` - Create new LP position
- `GET /aerodrome/position/:positionId` - Get position details
- `GET /aerodrome/positions/:walletLocator` - Get all positions for wallet
- `POST /aerodrome/burn` - Close and burn position
- `POST /aerodrome/collect-fees` - Collect accumulated fees

### Utility Endpoints

- `GET /aerodrome/pools` - Get available pools
- `GET /aerodrome/quote` - Get swap quote
- `POST /aerodrome/test-1inch` - Test 1inch integration
- `POST /aerodrome/retry-failed-mints` - Retry failed mint operations

## Installation

```bash
npm install
npm run build
npm run start:dev
```

## Usage

### Creating an LP Position

```bash
curl -X POST http://localhost:3000/aerodrome/mint \
  -H "Content-Type: application/json" \
  -d '{
    "walletLocator": "evm-base:0x...",
    "pool": "weth-usdc",
    "usdcAmount": 100
  }'
```

### Testing 1inch Integration

```bash
curl -X POST http://localhost:3000/aerodrome/test-1inch \
  -H "Content-Type: application/json" \
  -d '{
    "walletLocator": "evm-base:0x...",
    "sellToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "buyToken": "0x4200000000000000000000000000000000000006",
    "amount": "1000000"
  }'
```

## Architecture

The service uses a modular architecture with:

- **AerodromeService**: Core business logic for LP management
- **Crossmint Integration**: Secure wallet and transaction management
- **Multi-DEX Support**: 0x and 1inch for reliable token swaps
- **Automated Rebalancing**: Cron-based position monitoring and rebalancing
- **MongoDB**: Position and transaction data storage

## Rebalancing Logic

Positions are automatically rebalanced based on:

1. **Out of Range**: Current price outside position's tick range
2. **Dollar Value Loss**: Position value below 95% of original
3. **Token Imbalance**: One token >80% or <20% of total value
4. **Age Limit**: Positions older than 2 days

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT
