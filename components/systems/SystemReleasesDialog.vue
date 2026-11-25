<script setup lang="ts">
import { ref, watch } from 'vue'
import { useNuxtApp } from '#app'
import { useV3TargetsApi, type V3ReleaseRow, type V3ReleaseInput } from '@/composables/useV3TargetsApi'

// A system's releases (regular, beta, ...) and the domains each is served
// on. A facility is put on a release when it's created (Hospitals → Add
// facility, or the Register Hospital wizard); the Hospitals page can filter
// by release. "regular" always exists and can't be removed or retired.

const props = defineProps<{ stack: { key: string; label: string } | null }>()
const open = defineModel<boolean>({ default: false })

const api = useV3TargetsApi()
const { $showToast } = useNuxtApp()

const releases = ref<V3ReleaseRow[]>([])
const loading = ref(false)

async function load() {
  if (!props.stack) return
  loading.value = true
  try {
    releases.value = await api.listReleases(props.stack.key)
  } catch (e: any) {
    $showToast(e?.response?.data?.message || 'Failed to load releases.')
  } finally {
    loading.value = false
  }
}

watch(open, (o) => {
  if (o) {
    view.value = 'list'
    load()
  }
})

// ── Add / edit form ────────────────────────────────────────────────────────
const view = ref<'list' | 'form'>('list')
const editing = ref<V3ReleaseRow | null>(null)
const saving = ref(false)
const formError = ref('')
const fieldErrors = ref<Record<string, string>>({})
const form = ref({ key: '', label: '', app_url: '', cookie_domain: '', notes: '', active: true })

function openAdd() {
  editing.value = null
  form.value = { key: '', label: '', app_url: '', cookie_domain: '', notes: '', active: true }
  formError.value = ''
  fieldErrors.value = {}
  view.value = 'form'
}

function openEdit(r: V3ReleaseRow) {
  editing.value = r
  form.value = {
    key: r.key,
    label: r.label,
    app_url: r.app_url ?? '',
    cookie_domain: r.cookie_domain ?? '',
    notes: r.notes ?? '',
    active: r.active,
  }
  formError.value = ''
  fieldErrors.value = {}
  view.value = 'form'
}

async function save() {
  if (!props.stack) return
  saving.value = true
  formError.value = ''
  fieldErrors.value = {}
  const input: V3ReleaseInput = {
    label: form.value.label.trim(),
    app_url: form.value.app_url.trim() || null,
    cookie_domain: form.value.cookie_domain.trim() || null,
    notes: form.value.notes.trim() || null,
    active: form.value.active,
  }
  try {
    if (editing.value) {
      await api.updateRelease(props.stack.key, editing.value.key, input)
      $showToast('Release saved.')
    } else {
      await api.createRelease(props.stack.key, { ...input, key: form.value.key.trim() })
      $showToast('Release added.')
    }
    view.value = 'list'
    await load()
  } catch (e: any) {
    const errors = e?.response?.data?.errors ?? {}
    fieldErrors.value = Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, (v as string[])[0]]))
    formError.value = Object.keys(errors).length ? '' : e?.response?.data?.message || 'Could not save the release.'
  } finally {
    saving.value = false
  }
}

const removing = ref<string | null>(null)
async function remove(r: V3ReleaseRow) {
  if (!props.stack) return
  if (!confirm(`Remove the "${r.label}" release from ${props.stack.label}?`)) return
  removing.value = r.key
  try {
    await api.removeRelease(props.stack.key, r.key)
    $showToast('Release removed.')
    await load()
  } catch (e: any) {
    $showToast(e?.response?.data?.message || 'Could not remove the release.')
  } finally {
    removing.value = null
  }
}

const headers = [
  { title: 'Release', key: 'label', sortable: false },
  { title: 'App URL', key: 'app_url', sortable: false },
  { title: 'Cookie domain', key: 'cookie_domain', sortable: false },
  { title: 'Facilities', key: 'facilities', sortable: false, align: 'end' as const },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
]
</script>

<template>
  <v-dialog v-model="open" max-width="900">
    <v-card rounded="lg">
      <v-card-title class="text-h6 pt-5 px-5 d-flex align-center">
        <template v-if="view === 'list'">Releases · {{ stack?.label }}</template>
        <template v-else>{{ editing ? `Edit release · ${editing.label}` : `Add a release · ${stack?.label}` }}</template>
        <v-spacer />
        <v-btn v-if="view === 'list'" color="primary" variant="tonal" size="small" prepend-icon="mdi-plus" @click="openAdd">
          Add release
        </v-btn>
      </v-card-title>

      <!-- List -->
      <template v-if="view === 'list'">
        <v-card-text class="px-5 pb-0">
          <p class="textSecondary text-body-2 mb-2">
            Each facility on this system is on one release. Its users are served from the release's app URL, and
            the cookie domain lets their sign-in carry across releases.
          </p>
        </v-card-text>
        <v-data-table :headers="headers" :items="releases" :loading="loading" density="comfortable" hide-default-footer
          :items-per-page="-1">
          <template #item.label="{ item }">
            <div class="py-2">
              <div class="d-flex align-center ga-2">
                <span class="font-weight-medium">{{ item.label }}</span>
                <v-chip v-if="!item.active" size="x-small" color="grey" variant="tonal" label>Retired</v-chip>
              </div>
              <span class="text-caption textSecondary font-mono">{{ item.key }}</span>
              <div v-if="item.notes" class="text-caption textSecondary notes">{{ item.notes }}</div>
            </div>
          </template>
          <template #item.app_url="{ item }">
            <a v-if="item.app_url" :href="item.app_url" target="_blank" rel="noopener" class="text-primary">{{ item.app_url }}</a>
            <span v-else class="textSecondary">—</span>
          </template>
          <template #item.cookie_domain="{ item }">
            <span v-if="item.cookie_domain" class="font-mono">{{ item.cookie_domain }}</span>
            <span v-else class="textSecondary">—</span>
          </template>
          <template #item.facilities="{ item }">{{ item.facilities ?? 0 }}</template>
          <template #item.actions="{ item }">
            <div class="d-flex justify-end ga-1">
              <v-btn size="small" variant="text" icon="mdi-pencil" :aria-label="`Edit ${item.label}`" @click="openEdit(item)" />
              <v-btn v-if="!item.protected" size="small" variant="text" color="error" icon="mdi-delete-outline"
                :aria-label="`Remove ${item.label}`" :loading="removing === item.key" @click="remove(item)" />
            </div>
          </template>
        </v-data-table>
        <v-card-actions class="px-5 pb-5">
          <v-spacer />
          <v-btn variant="text" @click="open = false">Close</v-btn>
        </v-card-actions>
      </template>

      <!-- Add / edit -->
      <template v-else>
        <v-card-text class="px-5">
          <div class="d-flex ga-3 flex-wrap">
            <v-text-field v-model="form.key" label="Key" placeholder="e.g. pilot" :disabled="!!editing"
              :hint="editing ? 'Facilities point at the key, so it can\'t change.' : 'Lowercase; stored on each facility. Can\'t be changed later.'"
              persistent-hint :error-messages="fieldErrors.key" variant="outlined" density="comfortable"
              style="min-width:160px; max-width:220px" />
            <v-text-field v-model="form.label" label="Name" placeholder="e.g. Pilot" :error-messages="fieldErrors.label"
              variant="outlined" density="comfortable" style="min-width:220px" />
          </div>
          <v-text-field v-model="form.app_url" label="App URL" placeholder="https://beta.afyaanalytics.ai"
            hint="Where this release's ERP app is served (origin only)." persistent-hint :error-messages="fieldErrors.app_url"
            prepend-inner-icon="mdi-web" variant="outlined" density="comfortable" class="mt-2" />
          <v-text-field v-model="form.cookie_domain" label="Cookie domain" placeholder=".afyaanalytics.ai"
            hint="Parent domain the sign-in cookies are shared on, so users stay signed in across releases."
            persistent-hint :error-messages="fieldErrors.cookie_domain" prepend-inner-icon="mdi-cookie-outline"
            variant="outlined" density="comfortable" class="mt-2" />
          <v-textarea v-model="form.notes" label="Notes" rows="2" auto-grow :error-messages="fieldErrors.notes"
            variant="outlined" density="comfortable" class="mt-2" />
          <v-switch v-model="form.active" :disabled="editing?.protected" color="primary" hide-details inset
            :label="form.active ? 'Active — can be chosen for new facilities' : 'Retired — kept on record, can\'t be chosen'" />
          <v-alert v-if="formError" type="error" variant="tonal" density="compact" class="mt-3" :text="formError" />
        </v-card-text>
        <v-card-actions class="px-5 pb-5">
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="view = 'list'">Back</v-btn>
          <v-btn color="primary" variant="flat" :loading="saving" :disabled="!form.label.trim() || (!editing && !form.key.trim())"
            @click="save">{{ editing ? 'Save' : 'Add' }}</v-btn>
        </v-card-actions>
      </template>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.notes { max-width: 260px; white-space: normal; }
</style>
