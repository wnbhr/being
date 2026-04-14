import type { FastifyPluginAsync } from 'fastify'

export const oauthMetadataRoute: FastifyPluginAsync = async (app) => {
  // RFC 9728: Protected Resource Metadata
  app.get('/.well-known/oauth-protected-resource', async () => {
    return {
      resource: 'https://being.ruddia.com',
      authorization_servers: ['https://being.ruddia.com'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['being:full'],
      resource_documentation: 'https://docs.ruddia.com/api',
    }
  })

  // RFC 8414: Authorization Server Metadata
  app.get('/.well-known/oauth-authorization-server', async () => {
    return {
      issuer: 'https://being.ruddia.com',
      authorization_endpoint: 'https://being.ruddia.com/oauth/authorize',
      token_endpoint: 'https://being.ruddia.com/oauth/token',
      registration_endpoint: 'https://being.ruddia.com/oauth/register',
      scopes_supported: ['being:full'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      resource_indicators_supported: true,
    }
  })
}
