// IPC wrapper: unwraps { ok, data, error } and throws on failure.
TF.api = async (channel, payload) => {
  const res = await window.tf.invoke(channel, payload);
  if (!res || !res.ok) throw new Error((res && res.error) || 'IPC error');
  return res.data;
};

// Quiet variant: returns null instead of throwing (for background refreshes).
TF.apiQuiet = async (channel, payload) => {
  try { return await TF.api(channel, payload); } catch (_) { return null; }
};
