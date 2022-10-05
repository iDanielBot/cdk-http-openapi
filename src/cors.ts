import { aws_apigatewayv2 as apigwv2 } from 'aws-cdk-lib'
/**
 * corsConfig value to enable all origins
 */
export const CorsConfigAllOrigins: apigwv2.CfnApi.CorsProperty = {
  allowHeaders: ['*'],
  allowMethods: ['*'],
  allowOrigins: ['*']
}
