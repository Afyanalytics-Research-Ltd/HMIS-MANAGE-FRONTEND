import { useNuxtApp } from '#app'

export type MaintenanceMode = 'full' | 'partial'
/** Mirrors computePhase() in the HMIS frontend's utils/maintenanceWindow.ts. */
export type MaintenancePhase = 'notice' | 'lock' | 'completed' | 'normal'

export interface MaintenanceWindow {
  id: number
  enabled: boolean
  mode: MaintenanceMode
  phase: MaintenancePhase
  /** ISO-8601 with an explicit +03:00 (EAT) offset. */
  start: string
  end: string
  noticeAfterMinutes: number
  message: string | null
  bypassRoles: string[]
  allowSuperadminBypass: boolean
  cancelledAt: string | null
  createdBy: number | null
  createdAt: string
}

export interface MaintenanceState {
  current: MaintenanceWindow | null
  /** The control plane's clock, so the console never counts down on a wrong device clock. */
  serverNow: string
  history: MaintenanceWindow[]
  meta: { currentPage: number; lastPage: number; total: number }
}

export interface MaintenanceWindowInput {
  mode: MaintenanceMode
  starts_at: string
  ends_at: string
  notice_after_minutes?: number
  message?: string | null
  allow_superadmin_bypass?: boolean
}

/**
 * System-maintenance control (read: any platform user, write: system_admin).
 *
 * What these writes produce is served to every HMIS frontend by the public
 * GET /api/v1/maintenance endpoint and acted on by every open tab within a
 * minute — activating a full window takes the hospital system offline.
 */
export function useMaintenanceApi() {
  const { $axios } = useNuxtApp()

  async function state(page = 1): Promise<MaintenanceState> {
    const { data } = await $axios.get('/v1/platform/maintenance', { params: { page } })
    return data.data
  }

  async function create(input: MaintenanceWindowInput): Promise<MaintenanceWindow> {
    const { data } = await $axios.post('/v1/platform/maintenance', input)
    return data.data
  }

  async function update(id: number, input: Partial<MaintenanceWindowInput>): Promise<MaintenanceWindow> {
    const { data } = await $axios.patch(`/v1/platform/maintenance/${id}`, input)
    return data.data
  }

  /** Ends a running window now; the completion notice still shows afterwards. */
  async function endNow(id: number): Promise<MaintenanceWindow> {
    const { data } = await $axios.post(`/v1/platform/maintenance/${id}/end`)
    return data.data
  }

  /** Cancels a window outright — it vanishes from the public document. */
  async function cancel(id: number): Promise<MaintenanceWindow> {
    const { data } = await $axios.delete(`/v1/platform/maintenance/${id}`)
    return data.data
  }

  return { state, create, update, endNow, cancel }
}
