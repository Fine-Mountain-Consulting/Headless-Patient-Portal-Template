/**
 * A tiny synthetic Knack app: Accounts, Patients, Doctors, Appointments,
 * Results, with a patient portal, a doctor portal with a patient-details child
 * page, a public page and an orphaned page.
 */
export const snapshot = {
  id: 'a'.repeat(24),
  name: 'Fixture',
  slug: 'fixture',
  accountSlug: 'acme',
  settings: { timezone: 'Eastern Time (US & Canada)' },
  takenAt: '2026-01-01T00:00:00Z',
  objects: [
    { key: 'object_1', name: 'Accounts', user: true, profile_key: 'all_users', identifier: 'field_1', fields: [
      { key: 'field_1', name: 'Name', type: 'name' }, { key: 'field_2', name: 'Email', type: 'email' } ] },
    { key: 'object_2', name: 'Patients', user: true, profile_key: 'profile_2', identifier: 'field_3', fields: [
      { key: 'field_3', name: 'Name', type: 'name' }, { key: 'field_4', name: 'Email', type: 'email' },
      { key: 'field_5', name: 'Doctor', type: 'connection', relationship: { object: 'object_3', has: 'one' } },
      { key: 'field_6', name: 'Secret Note', type: 'short_text' } ] },
    { key: 'object_3', name: 'Doctors', user: true, profile_key: 'profile_3', identifier: 'field_7', fields: [
      { key: 'field_7', name: 'Name', type: 'name' }, { key: 'field_8', name: 'Email', type: 'email' } ] },
    { key: 'object_4', name: 'Appointments', identifier: 'field_9', fields: [
      { key: 'field_9', name: 'When', type: 'date_time' },
      { key: 'field_10', name: 'Patient', type: 'connection', relationship: { object: 'object_2', has: 'one' } },
      { key: 'field_11', name: 'Doctor', type: 'connection', relationship: { object: 'object_3', has: 'one' } },
      { key: 'field_12', name: 'Status', type: 'multiple_choice', format: { options: ['Scheduled', 'Cancelled'] } },
      { key: 'field_13', name: 'Internal', type: 'short_text' } ] },
    { key: 'object_5', name: 'Results', identifier: 'field_14', fields: [
      { key: 'field_14', name: 'Title', type: 'short_text' },
      { key: 'field_15', name: 'Patient', type: 'connection', relationship: { object: 'object_2', has: 'one' } },
      { key: 'field_16', name: 'Doctor', type: 'connection', relationship: { object: 'object_3', has: 'one' } } ] },
    { key: 'object_6', name: 'Headless Admin', user: true, profile_key: 'profile_6', identifier: 'field_17', fields: [
      { key: 'field_17', name: 'Name', type: 'name' }, { key: 'field_18', name: 'Email', type: 'email' } ] },
  ],
  scenes: [
    { key: 'scene_1', slug: 'home', name: 'Home', views: [
      { key: 'view_1', type: 'table', source: { object: 'object_4' }, columns: [{ field: { key: 'field_9' } }] } ] },
    { key: 'scene_2', slug: 'patient-login', name: 'Patient Login', authenticated: true, views: [
      { key: 'view_2', type: 'login', limit_profile_access: true, allowed_profiles: ['profile_2'] } ] },
    { key: 'scene_3', slug: 'patient-portal', name: 'Patient Portal', parent: 'patient-login', views: [
      { key: 'view_3', type: 'table', source: { object: 'object_4', criteria: { groups: [[{ field: 'field_10', operator: 'user' }]] } },
        columns: [{ field: { key: 'field_9' } }, { field: { key: 'field_11' } }, { field: { key: 'field_12' } }] },
      { key: 'view_4', type: 'form', action: 'create', source: { object: 'object_4', connection_key: 'field_10', authenticated_user: true },
        groups: [{ columns: [{ inputs: [{ field: { key: 'field_9' } }, { field: { key: 'field_11' } }] }] }],
        rules: { records: [{ action: 'record', criteria: [], values: [{ type: 'value', field: 'field_12', value: 'Scheduled' }] }] } } ] },
    { key: 'scene_4', slug: 'doctor-login', name: 'Doctor Login', authenticated: true, views: [
      { key: 'view_5', type: 'login', limit_profile_access: true, allowed_profiles: ['profile_3'] } ] },
    { key: 'scene_5', slug: 'doctor-portal', name: 'Doctor Portal', parent: 'doctor-login', views: [
      { key: 'view_6', type: 'table', source: { object: 'object_2', criteria: { groups: [[{ field: 'field_5', operator: 'user' }]] } },
        columns: [{ field: { key: 'field_3' } }, { type: 'delete', link_type: 'delete' }] } ] },
    { key: 'scene_6', slug: 'patient-details', name: 'Patient Details', parent: 'doctor-portal', object: 'object_2', views: [
      { key: 'view_7', type: 'details', source: { object: 'object_2' }, columns: [{ groups: [{ columns: [[{ type: 'field', key: 'field_3' }]] }] }] },
      { key: 'view_8', type: 'table', source: { object: 'object_5', connection_key: 'field_15', relationship_type: 'foreign' },
        columns: [{ field: { key: 'field_14' } }] },
      { key: 'view_9', type: 'form', action: 'create', source: { object: 'object_5', connection_key: 'field_15', relationship_type: 'foreign' },
        groups: [{ columns: [{ inputs: [{ field: { key: 'field_14' } }] }] }],
        rules: { records: [{ action: 'record', criteria: [], values: [{ type: 'user', field: 'field_16' }] }] } } ] },
    { key: 'scene_7', slug: 'stray', name: 'Stray', parent: 'gone', authenticated: true, views: [
      { key: 'view_10', type: 'form', action: 'create', source: { object: 'object_5' }, groups: [{ columns: [{ inputs: [{ field: { key: 'field_14' } }] }] }] } ] },
  ],
};
