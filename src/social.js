import { supabase } from './repository.js';

const PROFILE_FIELDS = 'user_id,handle,display_name,avatar_url,discoverable,created_at,updated_at';
const CONNECTION_FIELDS = `
  id,
  requester_id,
  addressee_id,
  status,
  created_at,
  updated_at,
  requester:profiles!connections_requester_id_fkey(user_id,handle,display_name,avatar_url,discoverable),
  addressee:profiles!connections_addressee_id_fkey(user_id,handle,display_name,avatar_url,discoverable)
`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUser(session) {
  const user = session?.user;
  if (!user?.id) {
    const error = new Error('Sign in to use Friends.');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  return user;
}

function queryError(error, fallback) {
  if (['401', '42501', 'PGRST301'].includes(String(error?.code || error?.status || ''))) {
    const authError = new Error('Your session could not be authorized. Sign in again.');
    authError.code = 'AUTH_REQUIRED';
    authError.cause = error;
    return authError;
  }
  const wrapped = new Error(error?.message || fallback);
  wrapped.code = error?.code || 'SOCIAL_REQUEST_FAILED';
  wrapped.cause = error;
  return wrapped;
}

function normalizedHandle(value, userId) {
  const base = String(value || 'traveler')
    .normalize('NFKD')
    .replace(/[ıİ]/g, 'i')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[şŞ]/g, 's')
    .replace(/[çÇ]/g, 'c')
    .replace(/[öÖ]/g, 'o')
    .replace(/[üÜ]/g, 'u')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'traveler';
  const suffix = String(userId).replace(/-/g, '').slice(-6).toLowerCase();
  return `${base.slice(0, 23)}-${suffix}`;
}

function profileFromUser(user) {
  const metadata = user.user_metadata || {};
  const emailName = String(user.email || '').split('@')[0];
  const displayName = String(metadata.full_name || metadata.name || emailName || 'Roamly traveler').trim().slice(0, 80);
  const avatarCandidate = String(metadata.avatar_url || metadata.picture || '').trim();
  let avatarUrl = null;
  try {
    const parsed = new URL(avatarCandidate);
    if (parsed.protocol === 'https:') avatarUrl = parsed.toString().slice(0, 2048);
  } catch {
    avatarUrl = null;
  }
  return {
    user_id: user.id,
    handle: normalizedHandle(metadata.user_name || metadata.preferred_username || emailName || displayName, user.id),
    display_name: displayName,
    avatar_url: avatarUrl,
    discoverable: true
  };
}

function validUuid(value, label) {
  const id = String(value || '').trim();
  if (!UUID_PATTERN.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

export function createSocialApi(client) {
  async function ensureProfile(session) {
    const user = requireUser(session);
    const existingResult = await client.from('profiles')
      .select(PROFILE_FIELDS)
      .eq('user_id', user.id)
      .maybeSingle();
    if (existingResult.error) throw queryError(existingResult.error, 'Your profile could not be loaded.');
    if (existingResult.data) return existingResult.data;

    const insertResult = await client.from('profiles')
      .insert(profileFromUser(user))
      .select(PROFILE_FIELDS)
      .single();
    if (!insertResult.error) return insertResult.data;

    if (insertResult.error.code === '23505') {
      const racedResult = await client.from('profiles')
        .select(PROFILE_FIELDS)
        .eq('user_id', user.id)
        .maybeSingle();
      if (!racedResult.error && racedResult.data) return racedResult.data;
    }
    throw queryError(insertResult.error, 'Your profile could not be created.');
  }

  async function searchProfiles(query, session) {
    const user = requireUser(session);
    const term = String(query || '')
      .trim()
      .replace(/[^\p{L}\p{N} -]/gu, '')
      .replace(/\s+/g, ' ')
      .slice(0, 50);
    if (term.length < 2) return [];

    const result = await client.from('profiles')
      .select(PROFILE_FIELDS)
      .eq('discoverable', true)
      .neq('user_id', user.id)
      .or(`handle.ilike.%${term}%,display_name.ilike.%${term}%`)
      .order('handle', { ascending: true })
      .limit(20);
    if (result.error) throw queryError(result.error, 'Profiles could not be searched.');
    return result.data || [];
  }

  async function loadConnections(session) {
    const user = requireUser(session);
    const result = await client.from('connections')
      .select(CONNECTION_FIELDS)
      .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
      .order('updated_at', { ascending: false });
    if (result.error) throw queryError(result.error, 'Connections could not be loaded.');
    return result.data || [];
  }

  async function requestConnection(userId, session) {
    const user = requireUser(session);
    const addresseeId = validUuid(userId, 'Profile');
    if (addresseeId === user.id) throw new Error('You cannot connect with yourself.');

    const result = await client.from('connections')
      .insert({ requester_id: user.id, addressee_id: addresseeId, status: 'pending' })
      .select(CONNECTION_FIELDS)
      .single();
    if (result.error?.code === '23505') throw new Error('A connection request already exists.');
    if (result.error?.code === '23503') throw new Error('That profile is no longer available.');
    if (result.error) throw queryError(result.error, 'The connection request could not be sent.');
    return result.data;
  }

  async function respondToConnection(id, status, session) {
    const user = requireUser(session);
    const connectionId = validUuid(id, 'Connection');
    if (!['accepted', 'declined'].includes(status)) throw new Error('Response must be accepted or declined.');

    const result = await client.from('connections')
      .update({ status })
      .eq('id', connectionId)
      .eq('addressee_id', user.id)
      .eq('status', 'pending')
      .select(CONNECTION_FIELDS)
      .maybeSingle();
    if (result.error) throw queryError(result.error, 'The connection request could not be updated.');
    if (!result.data) throw new Error('That pending connection request was not found.');
    return result.data;
  }

  async function removeConnection(id, session) {
    requireUser(session);
    const connectionId = validUuid(id, 'Connection');
    const result = await client.from('connections')
      .delete()
      .eq('id', connectionId)
      .select('id')
      .maybeSingle();
    if (result.error) throw queryError(result.error, 'The connection could not be removed.');
    if (!result.data) throw new Error('That connection was not found.');
    return connectionId;
  }

  return {
    ensureProfile,
    searchProfiles,
    loadConnections,
    requestConnection,
    respondToConnection,
    removeConnection
  };
}

export const {
  ensureProfile,
  searchProfiles,
  loadConnections,
  requestConnection,
  respondToConnection,
  removeConnection
} = createSocialApi(supabase);
