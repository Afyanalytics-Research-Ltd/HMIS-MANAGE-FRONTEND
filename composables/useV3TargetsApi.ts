import { useNuxtApp } from '#app'

// v3 stacks hospitals are provisioned into, and each stack's service
// connections. Mirrors V3TargetController::present() on the backend.
// Secrets are write-only: the API only says whether one is set and its
// last 4 characters.

export type V3ServiceKey = 'core' | 'evaluation' | 'inventory'

export interface V3ServiceConnection {
  url: string | null
  app_id: string | null
  secret_set: boolean
  secret_hint: string | null
  timeout: number | null
  configured: boolean
  // Where the values come from: set on this page, .env, or both (page wins).
  source: 'database' | 'env' | 'database+env' | null
}

export interface V3Stack {
  key: string
  label: string
  default: boolean
  in_env: boolean
  has_overrides: boolean
  available: boolean
  hospitals: number
  services: Record<V3ServiceKey, V3ServiceConnection>
  last_check: { at: string; ok: boolean; error: string | null } | null
}

// Field names the API takes, e.g. core_url, evaluation_app_secret, clear_inventory.
export type V3StackInput = { key?: string; label?: string | null } & Partial<Record<
  `${V3ServiceKey}_${'url' | 'app_id' | 'app_secret'}`, string | null
>> & Partial<Record<`${V3ServiceKey}_timeout`, number | null>> & Partial<Record<`clear_${V3ServiceKey}`, boolean>>

export interface V3TestResult {
  ok: boolean
  error: string | null
  probe: 'ping' | 'organizations' | null
  organizations: number | null
}

export function useV3TargetsApi() {
  const { $axios } = useNuxtApp()

  async function list(): Promise<V3Stack[]> {
    const { data } = await $axios.get('/v1/platform/v3-targets')
    return data.data
  }

  async function create(input: V3StackInput): Promise<V3Stack> {
    const { data } = await $axios.post('/v1/platform/v3-targets', input)
    return data.data
  }

  async function update(key: string, input: V3StackInput): Promise<V3Stack> {
    const { data } = await $axios.patch(`/v1/platform/v3-targets/${key}`, input)
    return data.data
  }

  /** Drops this page's values: back to .env, or removes a stack added here. */
  async function remove(key: string): Promise<V3Stack | null> {
    const { data } = await $axios.delete(`/v1/platform/v3-targets/${key}`)
    return data.data
  }

  async function testConnection(key: string): Promise<{ stack: V3Stack; result: V3TestResult }> {
    const { data } = await $axios.post(`/v1/platform/v3-targets/${key}/test-connection`)
    return { stack: data.data, result: data.result }
  }

  return { list, create, update, remove, testConnection }
}
