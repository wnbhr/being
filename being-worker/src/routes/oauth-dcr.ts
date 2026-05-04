/**
 * oauth-dcr.ts — OAuth 2.0 Dynamic Client Registration (RFC 7591) + Client ID Metadata Document
 *
 * POST /oauth/register           — DCR: client registration (no auth required)
 * GET  /oauth/clients/:client_id — CIMD: client metadata (no auth required)
 *
 * spec-39 §11-1
 * #754
 *
 * TODO: add DCR-specific rate limit (e.g. 10 req/min/IP) to prevent spam registration
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { config } from '../config.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

const SUPPORTED_SCOPES = ['being:full']

interface DcrRequestBody {
  client_name?: string
  redirect_uris?: string[]
  grant_types?: string[]
  response_types?: string[]
  token_endpoint_auth_method?: string
  scope?: string
}

export const oauthDcrRoute: FastifyPluginAsync = async (app) => {
  // POST /oauth/register — RFC 7591 Dynamic Client Registration
  app.post<{ Body: DcrRequestBody }>('/oauth/register', async (request, reply) => {
    const {
      client_name,
      redirect_uris,
      grant_types = ['authorization_code'],
      response_types,
      token_endpoint_auth_method = 'none',
      scope = 'being:full',
    } = request.body ?? {}

    // client_name is required (NOT NULL in DB)
    if (!client_name) {
      return reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'client_name is required' })
    }

    // redirect_uris is required and must not be empty
    if (!redirect_uris || redirect_uris.length === 0) {
      return reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' })
    }

    // token_endpoint_auth_method must be "none" or "client_secret_basic"
    if (token_endpoint_auth_method !== 'none' && token_endpoint_auth_method !== 'client_secret_basic') {
      return reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'token_endpoint_auth_method must be "none" or "client_secret_basic"' })
    }

    // grant_types must include "authorization_code" ("refresh_token" is also allowed)
    if (!grant_types.includes('authorization_code')) {
      return reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'grant_types must include "authorization_code"' })
    }

    // response_types must only include "code" if provided
    if (response_types && !response_types.every((t) => t === 'code')) {
      return reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'response_types only supports "code"' })
    }

    // scope must be a supported value
    if (!SUPPORTED_SCOPES.includes(scope)) {
      return reply.code(400).send({ error: 'invalid_scope', error_description: `scope must be one of: ${SUPPORTED_SCOPES.join(', ')}` })
    }

    const clientId = `cid_${crypto.randomUUID()}`
    const now = Math.floor(Date.now() / 1000)

    // Generate client_secret for confidential clients
    let clientSecretPlain: string | undefined
    let clientSecretHash: string | undefined
    if (token_endpoint_auth_method === 'client_secret_basic') {
      clientSecretPlain = 'csc_' + crypto.randomBytes(32).toString('base64url')
      clientSecretHash = crypto.createHash('sha256').update(clientSecretPlain).digest('hex')
    }

    const { error } = await supabase.from('oauth_clients').insert({
      client_id: clientId,
      client_name,
      redirect_uris,
      grant_types,
      token_endpoint_auth_method,
      scope,
      ...(clientSecretHash ? { client_secret: clientSecretHash } : {}),
    })

    if (error) return reply.code(500).send({ error: 'server_error', error_description: error.message })

    return reply.code(201).send({
      client_id: clientId,
      ...(clientSecretPlain ? { client_secret: clientSecretPlain } : {}),
      client_name,
      redirect_uris,
      grant_types,
      response_types: ['code'], // fixed value; no DB column, always "code"
      token_endpoint_auth_method,
      scope,
      client_id_issued_at: now,
    })
  })

  // GET /oauth/clients/:client_id — Client ID Metadata Document
  app.get<{ Params: { client_id: string } }>('/oauth/clients/:client_id', async (request, reply) => {
    const { client_id } = request.params

    const { data, error } = await supabase
      .from('oauth_clients')
      .select('client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method, scope, created_at, is_active')
      .eq('client_id', client_id)
      .single()

    if (error || !data || data.is_active === false) {
      return reply.code(404).send({ error: 'not_found' })
    }

    return reply.send({
      client_id: data.client_id,
      client_name: data.client_name,
      redirect_uris: data.redirect_uris,
      grant_types: data.grant_types,
      response_types: ['code'], // fixed value; no DB column, always "code"
      token_endpoint_auth_method: data.token_endpoint_auth_method,
      scope: data.scope,
      client_id_issued_at: Math.floor(new Date(data.created_at).getTime() / 1000),
    })
  })
}
