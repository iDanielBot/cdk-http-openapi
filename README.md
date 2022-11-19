# cdk-http-openapi

CDK Construct that lets you build AWS Api Gateway Http Api, backed by Lambdas, based on a OpenAPI spec file.


# Features

[] Deploy Api Gateway Http Api based on a OpenAPI spec file.
[] Each API Route will be backed by 1 NodeJS lambda.
[] Configure CORS for your API.
[] Add custom domain (eg: https://my-awesome-api.my-domain.com) to your API.
[] Enable custom authorizers to Http Api Lambda integrations.
[] Customize your lambdas's memory, timeouts, log retention, env variables and other stuff.


# Setup

Add latest package to your project with npm/yarn

```bash
npm i --save cdk-http-openapi
yarn add -D cdk-http-openapi
```


# Start using cdk constructs in your infrastructure definition <br>Examples

```typescript
import { HttpOpenApi } from 'cdk-http-openapi'
import { Construct } from 'constructs'
import { Stack } from 'aws-cdk-lib'

export class MyServiceStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
  ) {
    super(scope, id)
    // other resources for your microservice

    // define your API + lambdas
    const api = new HttpOpenApi(this, 'MyApi', {
      functionNamePrefix: 'cool-api',
      openApiSpec: './openapi.yml',
      lambdasSourcePath: './dist/src', // optional. It defaults to './.build/src'
      integrations: [
        {
          operationId: 'getEntity', // for each operation you define in your OpenAPI spec
          handler: 'api.getEntity', // you can register a lambda handler to handle your http request
        },
        {
          operationId: 'storeEntity',
          handler: 'api.storeEntity',
          timeoutSeconds: 5,        // timeout configuration for lambda
          memorySize: 512,          // memory configuration for lambda
          env: {                    // you can also inject ENV variables into your lambda
            DB_HOST: '...',
            DB_USERNAME: '...',
            DB_PASSWORD: '...'
          },
        }
      ]
    });

    const domainName = 'my-awesome-api.cool.io';
    const certificateArn = `arn:aws:acm:${AWS_REGION}:${AWS_ACCOUNT}:certificate/${CERTIFICATE_ID}`;
    const hostedZone = 'cool.io';

    api.enableCustomDomain(domainName, certificateArn, hostedZone);
  }
}



```