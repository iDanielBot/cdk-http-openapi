import * as fs from 'fs'

import { DomainName } from '@aws-cdk/aws-apigatewayv2-alpha'
import {
  aws_lambda as lambda,
  Stack,
  Duration,
  aws_route53 as route53,
  aws_certificatemanager as acm,
  aws_apigatewayv2 as apigwv2
} from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as YAML from 'yaml'

import { HttpApiProps, MethodMapping } from './types'
import { CorsConfigAllOrigins } from './cors'

const AUTHORIZER_KEY = 'custom_authorizer'

export class HttpOpenApi extends Construct {
  /**
   *  Api Resource being created based on openAPI definition
   */
  public readonly cfnApi: apigwv2.CfnApi

  /**
   * Default stage being created & deployed for the API
   */
  public readonly apiStage: apigwv2.CfnStage

  /**
   * Maps operationId to lambda Function that is being created
   */
  public readonly functions: Record<string, lambda.Function>

  public readonly permissions: Record<string, lambda.CfnPermission>

  /**
   * Maps operationId to http path and method - for routing purposes
   */
  public readonly methodMappings: Record<string, MethodMapping>

  constructor (scope: Construct, id: string, props: HttpApiProps) {
    super(scope, id)

    this.functions = {}
    this.permissions = {}

    const file = fs.readFileSync(props.openApiSpec, 'utf8')
    const spec = YAML.parse(file)
    const stack = Stack.of(this)

    this.methodMappings = this.buildMethodMappings(spec)

    this.cfnApi = new apigwv2.CfnApi(this, `${props.functionNamePrefix}`, {
      body: spec,
      tags: undefined
    })

    this.apiStage = new apigwv2.CfnStage(this, 'DefaultStage', {
      apiId: this.cfnApi.ref,
      stageName: '$default',
      autoDeploy: true
    })

    props.integrations.forEach((integration) => {
      const method = this.methodMappings[integration.operationId]
      if (!method) {
        throw new Error(`There is no path in the Open API Spec matching ${integration.operationId}`)
      } else {
        const funcName = `${props.functionNamePrefix}-${integration.operationId}`
        // TODO: Think about using NodeJS Lambdas
        const func = new lambda.Function(this, funcName, {
          functionName: funcName,
          runtime: lambda.Runtime.NODEJS_14_X,
          code: lambda.AssetCode.fromAsset(
            props.lambdasSourcePath ?? './.build/src'
          ),
          handler: integration.handler,
          logRetention: integration.logRetentionDays ?? 90,
          timeout: Duration.seconds(integration.timeoutSeconds ?? 3),
          memorySize: integration.memorySize ?? 128,
          environment: integration.env
        })

        this.functions[integration.operationId] = func

        if (props.customAuthorizerLambdaArn) {
          spec.paths[method.path][method.method].security = [
            {
              [AUTHORIZER_KEY]: []
            }
          ]
        }

        spec.paths[method.path][method.method][
          'x-amazon-apigateway-integration'
        ] = {
          type: 'AWS_PROXY',
          httpMethod: 'POST',
          uri: func.functionArn,
          payloadFormatVersion: '2.0'
        }
      }
    })

    // First loop with authorizers to add their configurations to the spec
    if (props.customAuthorizerLambdaArn) {
      spec.components.securitySchemes = {}
      // https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-swagger-extensions-authorizer.html
      spec.components.securitySchemes[AUTHORIZER_KEY] =
        this.toAuthorizerSpec(props.customAuthorizerLambdaArn, stack.region)
    }

    // add passed or default cors
    if (props.corsConfig) {
      spec['x-amazon-apigateway-cors'] = props.corsConfig
    } else if (props.corsAllowAllOrigins) {
      // Allow all origins
      spec['x-amazon-apigateway-cors'] = CorsConfigAllOrigins
    }

    // Second loop with Authorizers, in order to add InvokeFunction permission
    // to the created API. It has to be separated because we need the ref from cfnApi
    if (props.customAuthorizerLambdaArn) {
      const permission = new lambda.CfnPermission(this, 'AuthorizerPermission', {
        action: 'lambda:InvokeFunction',
        principal: 'apigateway.amazonaws.com',
        functionName: props.customAuthorizerLambdaArn,
        sourceArn: `arn:aws:execute-api:${stack.region}:${stack.account}:${this.cfnApi.ref}/*/*/*`
      })
      this.permissions[AUTHORIZER_KEY] = permission
    }

    Object.keys(this.functions).forEach((funcKey, idx) => {
      const func = this.functions[funcKey]
      const permission = new lambda.CfnPermission(this, `LambdaPermission_${idx}`, {
        action: 'lambda:InvokeFunction',
        principal: 'apigateway.amazonaws.com',
        functionName: func.functionName,
        sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${this.cfnApi.ref}/*/*`
      })
      this.permissions[funcKey] = permission
    })
  }

  /**
   * Enable custom domain for this API
   * @param customDomainName - customDomainName to be created in Api Gateway
   * @param certificateArn Arn of the certificate needed for the creation of custom domain. It must be a regional certificate.
   */
  public enableCustomDomain (
    customDomainName: string,
    certificateArn: string,
    zoneName: string
  ) {
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'SLSCertificate',
      certificateArn
    )

    const domainName = new DomainName(this, 'SLSDomainName', {
      domainName: customDomainName,
      certificate
    })

    const routeConfig: route53.ARecordProps = {
      recordName: customDomainName,
      zone: route53.HostedZone.fromLookup(this, 'SLSZoneLookup', {
        domainName: zoneName
      }),
      target: route53.RecordTarget.fromAlias({
        bind: () => ({
          dnsName: domainName.regionalDomainName,
          hostedZoneId: domainName.regionalHostedZoneId
        })
      })
    }
    const aRecord = new route53.ARecord(this, 'SLSCustomDomainARecord', routeConfig)
    const aaaaRecord = new route53.AaaaRecord(this, 'SLSCustomDomainAAAARecord', routeConfig)

    const apiMapping = new apigwv2.CfnApiMapping(this, 'SLSMapping', {
      apiId: this.cfnApi.ref,
      domainName: customDomainName,
      stage: this.apiStage.stageName
    })

    apiMapping.addDependsOn(this.cfnApi)
    apiMapping.addDependsOn(this.apiStage)
    apiMapping.node.addDependency(domainName)
    apiMapping.node.addDependency(aRecord)
    apiMapping.node.addDependency(aaaaRecord)
  }

  /**
   * Extracts path and method that map to the operationId needed
   * So finding the right place on the spec is just a matter of accessing the right attribute
   * @param spec
   * @returns methods
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildMethodMappings (spec: any) {
    const methods = {} as Record<string, MethodMapping>

    Object.keys(spec.paths).forEach((pathKey) => {
      const pathObj = spec.paths[pathKey]
      Object.keys(pathObj).forEach((method) => {
        methods[pathObj[method].operationId] = {
          path: pathKey,
          method
        }
      })
    })

    return methods
  }

  private toAuthorizerSpec (lambdaAuthorizerArn: string, region: string) {
    const uri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${lambdaAuthorizerArn}/invocations`

    return {
      type: 'apiKey',
      name: 'Authorization',
      in: 'header',
      'x-amazon-apigateway-authorizer': {
        type: 'request',
        identitySource: '$request.header.Authorization', // Request parameter mapping expression of the identity source. In this example, it is the 'auth' header.
        authorizerUri: uri,
        authorizerPayloadFormatVersion: '2.0',
        authorizerResultTtlInSeconds: 300
      }
    }
  }
}
