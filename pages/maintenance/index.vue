<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useNuxtApp } from '#app'
import {
  useMaintenanceApi,
  type MaintenanceMode,
  type MaintenancePhase,
  type MaintenanceWindow,
} from '@/composables/useMaintenanceApi'

/**
 * System maintenance control.
 *
 * This screen replaces a developer editing maintenance.json on every frontend
 * server and redeploying. What is saved here is served to every HMIS frontend
 * by the public /api/v1/maintenance endpoint and acted on by open tabs within
 * a minute — so a full window takes the hospital system offline for everyone
 * but a bypassing superadmin. The preview line in the dialog exists to make
 * that completely unambiguous before anything is saved.
 *
 * Every time is East Africa Time. The control plane's clock drives the
 * countdown, so a wrong device clock cannot mislead the operator.
 */
definePageMeta({ title: 'System Maintenance' })

const api = useMaintenanceApi()
const { $showToast } = useNuxtApp()

const ZONE = 'Africa/Nairobi'
const MINUTE = 60_000

const loading = ref(false)
const saving = ref(false)
const acting = ref(false)
const current = ref<MaintenanceWindow | null>(null)
const history = ref<MaintenanceWindow[]>([])

/** Device clock corrected to the control plane's, as the HMIS frontend does. */
const serverOffsetMs = ref(0)
const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined

// ── Time helpers. The operator types EAT; the API speaks ISO with +03:00. ──

/** 'YYYY-MM-DDTHH:mm' from a <input type="datetime-local">, read as EAT. */
const localToIso = (local: string) => `${local.slice(0, 16)}:00+03:00`

/** The inverse: an instant rendered as the datetime-local value for EAT. */
function isoToLocal(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso)
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {})
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`
}

const fmtDateTime = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso)).replace(',', '')
    : '—'

const fmtTime = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '—'

function humanDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}

// ── Live phase, recomputed every second (mirrors the HMIS state machine) ───

function phaseOf(w: MaintenanceWindow | null, at: number): MaintenancePhase {
  if (!w || w.cancelledAt) return 'normal'
  const start = Date.parse(w.start)
  const end = Date.parse(w.end)
  const noticeEnd = end + w.noticeAfterMinutes * MINUTE
  if (at < start) return 'notice'
  if (at < end) return 'lock'
  if (at < noticeEnd) return 'completed'
  return 'normal'
}

const phase = computed(() => phaseOf(current.value, now.value))
const isRunning = computed(() => phase.value === 'lock')
const isScheduled = computed(() => phase.value === 'notice')

const status = computed(() => {
  const w = current.value
  if (!w || phase.value === 'normal') {
    return { label: 'Normal operation', color: 'success', icon: 'mdi-check-circle-outline' }
  }
  if (phase.value === 'notice') {
    return { label: 'Scheduled — users are being warned', color: 'info', icon: 'mdi-clock-outline' }
  }
  if (phase.value === 'completed') {
    return { label: 'Finished — showing the completion notice', color: 'success', icon: 'mdi-check-decagram-outline' }
  }
  return w.mode === 'full'
    ? { label: 'IN PROGRESS — system locked', color: 'error', icon: 'mdi-lock-outline' }
    : { label: 'IN PROGRESS — partial (banner only)', color: 'warning', icon: 'mdi-alert-outline' }
})

/** Time to the next thing that changes for users, counted on the server clock. */
const countdown = computed(() => {
  const w = current.value
  if (!w) return null
  const start = Date.parse(w.start)
  const end = Date.parse(w.end)
  const noticeEnd = end + w.noticeAfterMinutes * MINUTE
  if (now.value < start) return { verb: 'Locks in', text: humanDuration(start - now.value) }
  if (now.value < end) return { verb: 'Lifts in', text: humanDuration(end - now.value) }
  if (now.value < noticeEnd) return { verb: 'Notice clears in', text: humanDuration(noticeEnd - now.value) }
  return null
})

// ── Loading ───────────────────────────────────────────────────────────────

async function load() {
  loading.value = true
  try {
    const state = await api.state()
    current.value = state.current
    history.value = state.history
    serverOffsetMs.value = Date.parse(state.serverNow) - Date.now()
    now.value = Date.now() + serverOffsetMs.value
  } catch (e: any) {
    $showToast(e?.response?.data?.message || 'Could not load the maintenance state.')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  clockTimer = setInterval(() => { now.value = Date.now() + serverOffsetMs.value }, 1000)
  // Another admin may have changed things; keep this screen honest.
  pollTimer = setInterval(load, 30_000)
})
onBeforeUnmount(() => { clearInterval(clockTimer); clearInterval(pollTimer) })

// ── The dialog ────────────────────────────────────────────────────────────

const DURATIONS = [
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: '4 hours', minutes: 240 },
  { label: '8 hours', minutes: 480 },
  { label: 'Custom…', minutes: 0 },
]

const dialog = ref(false)
const editingId = ref<number | null>(null)
const formError = ref('')

const form = reactive({
  mode: 'full' as MaintenanceMode,
  startNow: true,
  startAt: '',
  durationMinutes: 120,
  endAt: '',
  noticeAfterMinutes: 30,
  message: '',
  allowSuperadminBypass: true,
})

const dialogTitle = computed(() =>
  editingId.value === null
    ? (form.startNow ? 'Activate maintenance now' : 'Schedule a maintenance window')
    : (isRunning.value ? 'Change the running window' : 'Edit the scheduled window'),
)

const startIso = computed(() => {
  if (editingId.value === null && form.startNow) return new Date(now.value).toISOString()
  if (editingId.value !== null && isRunning.value && current.value) return current.value.start
  return form.startAt ? localToIso(form.startAt) : ''
})

const endIso = computed(() => {
  if (!startIso.value) return ''
  if (form.durationMinutes > 0) {
    return new Date(Date.parse(startIso.value) + form.durationMinutes * MINUTE).toISOString()
  }
  return form.endAt ? localToIso(form.endAt) : ''
})

/** Spelled out in full, because this is the moment before the hospital goes dark. */
const preview = computed(() => {
  if (!startIso.value || !endIso.value) return ''
  const span = `${fmtDateTime(startIso.value)} → ${fmtTime(endIso.value)} EAT (${humanDuration(Date.parse(endIso.value) - Date.parse(startIso.value))})`
  const who = form.mode === 'full'
    ? (form.allowSuperadminBypass
        ? 'Every user is locked out of the HMIS. Superadmins keep working, behind a warning bar.'
        : 'Every user is locked out of the HMIS, superadmins included.')
    : 'Everyone keeps full access. A warning banner stays on screen for the whole window.'
  const warn = `From now until it starts, users see an advance-notice dialog and a top-bar chip. For ${form.noticeAfterMinutes} minutes afterwards they see "upgrade complete".`
  return `${span}\n${who}\n${warn}`
})

function openCreate(startNow: boolean) {
  editingId.value = null
  formError.value = ''
  Object.assign(form, {
    mode: 'full',
    startNow,
    startAt: isoToLocal(new Date(now.value + 60 * MINUTE)),
    durationMinutes: 120,
    endAt: isoToLocal(new Date(now.value + 180 * MINUTE)),
    noticeAfterMinutes: 30,
    message: '',
    allowSuperadminBypass: true,
  })
  dialog.value = true
}

function openEdit() {
  const w = current.value
  if (!w) return
  editingId.value = w.id
  formError.value = ''
  Object.assign(form, {
    mode: w.mode,
    startNow: false,
    startAt: isoToLocal(w.start),
    durationMinutes: 0, // editing works off an explicit end time
    endAt: isoToLocal(w.end),
    noticeAfterMinutes: w.noticeAfterMinutes,
    message: w.message ?? '',
    allowSuperadminBypass: w.allowSuperadminBypass,
  })
  dialog.value = true
}

async function save() {
  formError.value = ''
  if (!startIso.value || !endIso.value) {
    formError.value = 'Set when the window starts and ends.'
    return
  }
  if (Date.parse(endIso.value) <= Date.parse(startIso.value)) {
    formError.value = 'The window has to end after it starts.'
    return
  }

  saving.value = true
  try {
    const payload = {
      mode: form.mode,
      starts_at: startIso.value,
      ends_at: endIso.value,
      notice_after_minutes: form.noticeAfterMinutes,
      message: form.message.trim() || null,
      allow_superadmin_bypass: form.allowSuperadminBypass,
    }

    if (editingId.value === null) {
      await api.create(payload)
      $showToast(form.startNow ? 'Maintenance is now active.' : 'Maintenance window scheduled.')
    } else {
      // A running window keeps its start; sending it back would be refused.
      const { starts_at, ...rest } = payload
      await api.update(editingId.value, isRunning.value ? rest : payload)
      $showToast('Maintenance window updated.')
    }
    dialog.value = false
    await load()
  } catch (e: any) {
    formError.value = e?.response?.data?.message
      || Object.values(e?.response?.data?.errors ?? {}).flat()[0]
      || 'Could not save the window.'
  } finally {
    saving.value = false
  }
}

// ── End / cancel ──────────────────────────────────────────────────────────

const confirm = reactive({ open: false, kind: '' as 'end' | 'cancel' | '' })

function askEnd() { confirm.kind = 'end'; confirm.open = true }
function askCancel() { confirm.kind = 'cancel'; confirm.open = true }

async function runConfirmed() {
  const w = current.value
  if (!w) return
  acting.value = true
  try {
    if (confirm.kind === 'end') {
      await api.endNow(w.id)
      $showToast('Maintenance ended. Users are seeing the completion notice.')
    } else {
      await api.cancel(w.id)
      $showToast('Maintenance window cancelled.')
    }
    confirm.open = false
    await load()
  } catch (e: any) {
    $showToast(e?.response?.data?.message || 'That did not work.')
  } finally {
    acting.value = false
  }
}

// ── History table ─────────────────────────────────────────────────────────

const headers = [
  { title: 'Window', key: 'start', sortable: false },
  { title: 'Mode', key: 'mode', sortable: false },
  { title: 'Length', key: 'length', sortable: false },
  { title: 'Outcome', key: 'outcome', sortable: false },
]

function outcomeOf(w: MaintenanceWindow) {
  if (w.cancelledAt) return { label: 'Cancelled', color: 'grey' }
  const at = now.value
  const p = phaseOf(w, at)
  if (p === 'lock') return { label: 'Running', color: 'error' }
  if (p === 'notice') return { label: 'Scheduled', color: 'info' }
  return { label: 'Completed', color: 'success' }
}
</script>

<template>
  <div>
    <div class="d-flex flex-wrap align-center justify-space-between mb-6 ga-3">
      <div>
        <h2 class="text-h4 font-weight-semibold">System Maintenance</h2>
        <p class="textSecondary mb-0">
          Take the hospital system offline for planned work, or warn users while it stays up.
          Changes reach every open session within a minute — no deploy needed.
        </p>
      </div>
    </div>

    <!-- ── Status ─────────────────────────────────────────────────────── -->
    <v-card rounded="lg" elevation="10" class="mb-6">
      <v-card-text class="pa-6">
        <div class="d-flex flex-wrap align-center ga-3 mb-4">
          <v-chip :color="status.color" variant="tonal" label size="large" :prepend-icon="status.icon">
            {{ status.label }}
          </v-chip>
          <v-chip v-if="countdown" color="grey" variant="tonal" label size="large">
            {{ countdown.verb }} {{ countdown.text }}
          </v-chip>
          <v-progress-circular v-if="loading" indeterminate size="20" width="2" color="primary" />
        </div>

        <div v-if="current && phase !== 'normal'" class="mb-4">
          <div class="text-body-1 font-weight-medium">
            {{ fmtDateTime(current.start) }} → {{ fmtTime(current.end) }} EAT
            <span class="textSecondary">({{ humanDuration(Date.parse(current.end) - Date.parse(current.start)) }})</span>
          </div>
          <p v-if="current.message" class="textSecondary mb-1 mt-1">“{{ current.message }}”</p>
          <p class="textSecondary text-body-2 mb-0">
            <template v-if="current.mode === 'full'">
              Full lockout.
              <template v-if="current.allowSuperadminBypass">Superadmins can still get in.</template>
              <template v-else>Nobody can get in, superadmins included.</template>
            </template>
            <template v-else>Partial — everyone keeps working behind a warning banner.</template>
          </p>
        </div>

        <p v-else class="textSecondary mb-4">
          No maintenance window is scheduled. The HMIS is running normally.
        </p>

        <div class="d-flex flex-wrap ga-3">
          <template v-if="!current || phase === 'normal' || phase === 'completed'">
            <v-btn color="error" variant="flat" prepend-icon="mdi-power" @click="openCreate(true)">
              Activate maintenance now
            </v-btn>
            <v-btn color="primary" variant="tonal" prepend-icon="mdi-calendar-clock" @click="openCreate(false)">
              Schedule a window
            </v-btn>
            <v-btn
              v-if="phase === 'completed'"
              variant="text" prepend-icon="mdi-close"
              :loading="acting" @click="askCancel"
            >Clear the completion notice</v-btn>
          </template>

          <template v-else-if="isRunning">
            <v-btn color="success" variant="flat" prepend-icon="mdi-check" @click="askEnd">
              End maintenance now
            </v-btn>
            <v-btn color="primary" variant="tonal" prepend-icon="mdi-clock-plus-outline" @click="openEdit">
              Extend or change
            </v-btn>
          </template>

          <template v-else-if="isScheduled">
            <v-btn color="primary" variant="tonal" prepend-icon="mdi-pencil" @click="openEdit">
              Edit the window
            </v-btn>
            <v-btn color="error" variant="text" prepend-icon="mdi-cancel" @click="askCancel">
              Cancel it
            </v-btn>
          </template>
        </div>
      </v-card-text>
    </v-card>

    <!-- ── History ────────────────────────────────────────────────────── -->
    <v-card rounded="lg" elevation="10">
      <v-card-title class="text-h6 pt-5 px-5">Past windows</v-card-title>
      <v-data-table :headers="headers" :items="history" :loading="loading" density="comfortable">
        <template #item.start="{ item }">
          <div class="font-weight-medium">{{ fmtDateTime(item.start) }}</div>
          <span class="text-caption textSecondary">to {{ fmtTime(item.end) }} EAT</span>
        </template>
        <template #item.mode="{ item }">
          <v-chip size="small" :color="item.mode === 'full' ? 'error' : 'warning'" variant="tonal" label>
            {{ item.mode === 'full' ? 'Full lockout' : 'Partial' }}
          </v-chip>
        </template>
        <template #item.length="{ item }">
          {{ humanDuration(Date.parse(item.end) - Date.parse(item.start)) }}
        </template>
        <template #item.outcome="{ item }">
          <v-chip size="small" :color="outcomeOf(item).color" variant="tonal" label>
            {{ outcomeOf(item).label }}
          </v-chip>
        </template>
        <template #no-data>
          <div class="pa-10 text-center">
            <v-avatar color="primary" variant="tonal" size="64" class="mb-3">
              <v-icon icon="mdi-wrench-outline" size="34" />
            </v-avatar>
            <h3 class="text-h6 mb-1">No maintenance yet</h3>
            <p class="textSecondary">Windows you schedule will be listed here.</p>
          </div>
        </template>
      </v-data-table>
    </v-card>

    <!-- ── Create / edit ──────────────────────────────────────────────── -->
    <v-dialog v-model="dialog" max-width="620" scrollable>
      <v-card rounded="lg">
        <v-card-title class="text-h6 pt-5 px-5">{{ dialogTitle }}</v-card-title>
        <v-card-text class="px-5">
          <!-- Mode -->
          <div class="text-subtitle-2 mb-2">What happens to users</div>
          <v-btn-toggle v-model="form.mode" mandatory divided variant="outlined" class="mb-2 w-100">
            <v-btn value="full" class="flex-grow-1" prepend-icon="mdi-lock-outline">Full lockout</v-btn>
            <v-btn value="partial" class="flex-grow-1" prepend-icon="mdi-alert-outline">Partial</v-btn>
          </v-btn-toggle>
          <p class="textSecondary text-body-2 mb-5">
            <template v-if="form.mode === 'full'">
              The whole HMIS is replaced by a maintenance page. Nobody can work.
            </template>
            <template v-else>
              The HMIS stays fully usable; a warning banner tells users work is going on.
            </template>
          </p>

          <!-- Start -->
          <div class="text-subtitle-2 mb-2">Starts</div>
          <v-radio-group v-if="editingId === null" v-model="form.startNow" inline density="compact" hide-details class="mb-2">
            <v-radio :value="true" label="Now" />
            <v-radio :value="false" label="At a set time" />
          </v-radio-group>
          <v-text-field
            v-if="editingId !== null ? !isRunning : !form.startNow"
            v-model="form.startAt"
            type="datetime-local"
            variant="outlined"
            density="compact"
            hint="East Africa Time"
            persistent-hint
            class="mb-4"
          />
          <p v-else-if="editingId !== null && isRunning" class="textSecondary text-body-2 mb-4">
            Started {{ fmtDateTime(current?.start ?? null) }} EAT — a running window's start cannot be moved.
          </p>

          <!-- Duration -->
          <div class="text-subtitle-2 mb-2">Lasts</div>
          <v-chip-group v-model="form.durationMinutes" mandatory selected-class="text-primary" class="mb-2">
            <v-chip v-for="d in DURATIONS" :key="d.minutes" :value="d.minutes" variant="outlined" filter>
              {{ d.label }}
            </v-chip>
          </v-chip-group>
          <v-text-field
            v-if="form.durationMinutes === 0"
            v-model="form.endAt"
            type="datetime-local"
            label="Ends at"
            variant="outlined"
            density="compact"
            hint="East Africa Time"
            persistent-hint
            class="mb-4"
          />

          <!-- Notice + message -->
          <v-text-field
            v-model.number="form.noticeAfterMinutes"
            type="number" min="0" max="1440"
            label="Show “upgrade complete” for (minutes)"
            variant="outlined" density="compact" class="mt-4"
          />
          <v-textarea
            v-model="form.message"
            label="Message to users (optional)"
            placeholder="e.g. Database upgrade and index rebuild."
            variant="outlined" density="compact" rows="2" counter="500"
          />
          <v-checkbox
            v-if="form.mode === 'full'"
            v-model="form.allowSuperadminBypass"
            density="compact" hide-details
            label="Let superadmins keep working during the lockout"
          />
          <p v-if="form.mode === 'full' && !form.allowSuperadminBypass" class="text-body-2 text-error mb-0 mt-1">
            Nobody will be able to reach the HMIS, including you.
          </p>

          <!-- Preview -->
          <v-alert v-if="preview" type="info" variant="tonal" density="compact" class="mt-5">
            <div class="text-body-2 preview">{{ preview }}</div>
          </v-alert>

          <v-alert v-if="formError" type="error" variant="tonal" density="compact" class="mt-4">
            {{ formError }}
          </v-alert>
        </v-card-text>
        <v-card-actions class="px-5 pb-5">
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="dialog = false">Cancel</v-btn>
          <v-btn
            :color="form.mode === 'full' ? 'error' : 'warning'"
            variant="flat" :loading="saving" @click="save"
          >
            {{ editingId === null ? (form.startNow ? 'Activate now' : 'Schedule') : 'Save changes' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ── Confirm end / cancel ───────────────────────────────────────── -->
    <v-dialog v-model="confirm.open" max-width="460">
      <v-card rounded="lg">
        <v-card-title class="text-h6 pt-5 px-5">
          {{ confirm.kind === 'end' ? 'End maintenance now?' : 'Cancel this window?' }}
        </v-card-title>
        <v-card-text class="px-5 textSecondary">
          <template v-if="confirm.kind === 'end'">
            The HMIS comes back for everyone within a minute, and users see a
            “system upgrade complete” notice for {{ current?.noticeAfterMinutes ?? 30 }} minutes.
          </template>
          <template v-else>
            The window disappears. Users stop seeing the advance notice straight away.
          </template>
        </v-card-text>
        <v-card-actions class="px-5 pb-5">
          <v-spacer />
          <v-btn variant="text" :disabled="acting" @click="confirm.open = false">Keep it</v-btn>
          <v-btn
            :color="confirm.kind === 'end' ? 'success' : 'error'"
            variant="flat" :loading="acting" @click="runConfirmed"
          >
            {{ confirm.kind === 'end' ? 'End now' : 'Cancel window' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.ga-3 { gap: 12px; }
.preview { white-space: pre-line; }
</style>
