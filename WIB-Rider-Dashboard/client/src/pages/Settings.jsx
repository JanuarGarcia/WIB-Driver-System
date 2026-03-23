import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import MapMerchantFilter from '../components/MapMerchantFilter';
import { sanitizeMerchantDisplayName } from '../utils/displayText';

function SearchableMerchantSelect({ merchants, excludedIds, onSelect, 'aria-label': ariaLabel }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  const available = merchants.filter((m) => {
    const id = m.merchant_id ?? m.id;
    return !excludedIds.some((x) => x == id);
  });
  const filtered = query.trim()
    ? available.filter((m) => {
        const id = m.merchant_id ?? m.id;
        const name = (sanitizeMerchantDisplayName(m.restaurant_name) || `Merchant ${id}`).toLowerCase();
        return name.includes(query.trim().toLowerCase());
      })
    : available;

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (id) => {
    onSelect(id);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="searchable-merchant-select" ref={containerRef}>
      <div className="searchable-merchant-input-wrap">
        <input
          type="text"
          className="form-control settings-select-add"
          placeholder="Select merchant…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          autoComplete="off"
        />
        <span className="searchable-merchant-chevron" aria-hidden>▼</span>
      </div>
      {open && (
        <ul className="searchable-merchant-dropdown" role="listbox">
          {filtered.length === 0 ? (
            <li className="searchable-merchant-option empty">No merchants match</li>
          ) : (
            filtered.map((m) => {
              const id = m.merchant_id ?? m.id;
              const name = sanitizeMerchantDisplayName(m.restaurant_name) || `Merchant ${id}`;
              return (
                <li
                  key={id}
                  role="option"
                  className="searchable-merchant-option"
                  onMouseDown={(e) => { e.preventDefault(); handleSelect(id); }}
                >
                  {name}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'map-keys', label: 'Map API keys' },
  { id: 'fcm', label: 'Firebase (FCM)' },
  { id: 'map-settings', label: 'Map settings' },
  { id: 'cron', label: 'Cron jobs' },
  { id: 'update-db', label: 'Update database' },
];

export default function Settings() {
  const [activeTab, setActiveTab] = useState('general');
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [fcmFile, setFcmFile] = useState('');
  const [fcmServiceAccountJson, setFcmServiceAccountJson] = useState(null);
  const [merchants, setMerchants] = useState([]);
  const [allowAllAdminTeam, setAllowAllAdminTeam] = useState(false);
  const [setCertainMerchantAdminTeam, setSetCertainMerchantAdminTeam] = useState(false);
  const [adminTeamMerchantIds, setAdminTeamMerchantIds] = useState([]);
  const [taskOwner, setTaskOwner] = useState('admin');
  const [merchantTaskOwnerAdminIds, setMerchantTaskOwnerAdminIds] = useState([]);
  const [adminShowOnlyAdminTask, setAdminShowOnlyAdminTask] = useState(false);
  const [doNotAllowMerchantDeleteTask, setDoNotAllowMerchantDeleteTask] = useState(true);
  const [merchantDeleteTaskDays, setMerchantDeleteTaskDays] = useState('');
  const [blockMerchantIds, setBlockMerchantIds] = useState([]);
  const [allowTaskSuccessfulWhen, setAllowTaskSuccessfulWhen] = useState('picture_proof');
  const [orderStatusAccepted, setOrderStatusAccepted] = useState([]);
  const [orderStatusCancel, setOrderStatusCancel] = useState('Cancel');
  const [deliveryTime, setDeliveryTime] = useState('');
  const [hideTotalOrderAmount, setHideTotalOrderAmount] = useState(false);
  const [appName, setAppName] = useState('WIB Rider');
  const [sendPushOnlyOnlineDriver, setSendPushOnlyOnlineDriver] = useState(false);
  const [enabledNotes, setEnabledNotes] = useState(true);
  const [enabledSignature, setEnabledSignature] = useState(false);
  const [mandatorySignature, setMandatorySignature] = useState(false);
  const [enabledSignup, setEnabledSignup] = useState(false);
  const [enabledAddPhotoTakePicture, setEnabledAddPhotoTakePicture] = useState(true);
  const [enabledResizePicture, setEnabledResizePicture] = useState(true);
  const [resizePictureWidth, setResizePictureWidth] = useState('500');
  const [resizePictureHeight, setResizePictureHeight] = useState('600');
  const [deviceVibration, setDeviceVibration] = useState('3000');
  const [signupStatus, setSignupStatus] = useState('active');
  const [signupNotificationEmails, setSignupNotificationEmails] = useState('');
  const [language, setLanguage] = useState('en');
  const [localizeCalendarLanguage, setLocalizeCalendarLanguage] = useState('en');
  const [driverTrackingOption, setDriverTrackingOption] = useState('1');
  const [recordsDriverLocation, setRecordsDriverLocation] = useState(false);
  const [disabledTracking, setDisabledTracking] = useState(false);
  const [trackInterval, setTrackInterval] = useState('10');
  const [taskCriticalOptionsEnabled, setTaskCriticalOptionsEnabled] = useState(false);
  const [taskCriticalOptionsMinutes, setTaskCriticalOptionsMinutes] = useState('5');
  const [privacyPolicyLink, setPrivacyPolicyLink] = useState('');
  const [defaultMapCountry, setDefaultMapCountry] = useState('ph');
  const [disableActivityTracking, setDisableActivityTracking] = useState(false);
  const [activityRefreshInterval, setActivityRefreshInterval] = useState('60');
  const [driverActivityRefresh, setDriverActivityRefresh] = useState(true);
  const [autoGeocodeAddress, setAutoGeocodeAddress] = useState(false);
  const [includeOfflineDriversOnMap, setIncludeOfflineDriversOnMap] = useState(true);
  const [hidePickupTasks, setHidePickupTasks] = useState(false);
  const [hideDeliveryTasks, setHideDeliveryTasks] = useState(false);
  const [hideSuccessfulTasks, setHideSuccessfulTasks] = useState(false);
  const [googleMapStyle, setGoogleMapStyle] = useState('');

  const ORDER_STATUS_ACCEPTED_OPTIONS = ['Pending', 'Processing', 'Accepted', 'Preparing', 'Ready For Pickup', 'Paid Na', 'paid', 'Advance Order'];

  const fetchSettings = () => {
    setLoading(true);
    api('settings').then(setSettings).catch(() => ({})).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  useEffect(() => {
    api('merchants').then((list) => setMerchants(Array.isArray(list) ? list : [])).catch(() => setMerchants([]));
  }, []);

  useEffect(() => {
    setAllowAllAdminTeam(settings.allow_all_admin_team_by_merchant === '1');
    setSetCertainMerchantAdminTeam(settings.set_certain_merchant_admin_team === '1');
    setAdminTeamMerchantIds(Array.isArray(settings.admin_team_merchant_ids) ? settings.admin_team_merchant_ids : []);
    setTaskOwner(settings.task_owner === 'merchant' ? 'merchant' : 'admin');
    setMerchantTaskOwnerAdminIds(Array.isArray(settings.merchant_task_owner_admin_ids) ? settings.merchant_task_owner_admin_ids : []);
    setAdminShowOnlyAdminTask(settings.admin_show_only_admin_task === '1');
    setDoNotAllowMerchantDeleteTask(settings.do_not_allow_merchant_delete_task !== '0');
    setMerchantDeleteTaskDays(settings.merchant_delete_task_days != null ? String(settings.merchant_delete_task_days) : '');
    setBlockMerchantIds(Array.isArray(settings.block_merchant_ids) ? settings.block_merchant_ids : []);
    setAllowTaskSuccessfulWhen(settings.allow_task_successful_when || 'picture_proof');
    setOrderStatusAccepted(Array.isArray(settings.order_status_accepted) ? settings.order_status_accepted : []);
    setOrderStatusCancel(settings.order_status_cancel || 'Cancel');
    setDeliveryTime(settings.delivery_time != null ? String(settings.delivery_time) : '');
    setHideTotalOrderAmount(settings.hide_total_order_amount === '1');
    setAppName(settings.app_name != null ? String(settings.app_name) : 'WIB Rider');
    setSendPushOnlyOnlineDriver(settings.send_push_only_online_driver === '1');
    setEnabledNotes(settings.enabled_notes !== '0');
    setEnabledSignature(settings.enabled_signature === '1');
    setMandatorySignature(settings.mandatory_signature === '1');
    setEnabledSignup(settings.enabled_signup === '1');
    setEnabledAddPhotoTakePicture(settings.enabled_add_photo_take_picture !== '0');
    setEnabledResizePicture(settings.enabled_resize_picture !== '0');
    setResizePictureWidth(settings.resize_picture_width != null ? String(settings.resize_picture_width) : '500');
    setResizePictureHeight(settings.resize_picture_height != null ? String(settings.resize_picture_height) : '600');
    setDeviceVibration(settings.device_vibration != null ? String(settings.device_vibration) : '3000');
    setSignupStatus(settings.signup_status || 'active');
    setSignupNotificationEmails(settings.signup_notification_emails != null ? String(settings.signup_notification_emails) : '');
    setLocalizeCalendarLanguage(settings.localize_calendar_language || 'en');
    setDriverTrackingOption(settings.driver_tracking_option === '2' ? '2' : '1');
    setRecordsDriverLocation(settings.records_driver_location === '1');
    setDisabledTracking(settings.disabled_tracking === '1');
    setTrackInterval(settings.track_interval != null ? String(settings.track_interval) : '10');
    setTaskCriticalOptionsEnabled(settings.task_critical_options_enabled === '1');
    setTaskCriticalOptionsMinutes(settings.task_critical_options_minutes != null ? String(settings.task_critical_options_minutes) : '5');
    setPrivacyPolicyLink(settings.privacy_policy_link != null ? String(settings.privacy_policy_link) : '');
    setLanguage(settings.language != null && settings.language !== '' ? String(settings.language) : (settings.app_default_language || 'en'));
    setDefaultMapCountry(settings.default_map_country != null ? String(settings.default_map_country) : 'ph');
    setDisableActivityTracking(settings.disable_activity_tracking === '1');
    setActivityRefreshInterval(settings.activity_refresh_interval != null && settings.activity_refresh_interval !== '' ? String(settings.activity_refresh_interval) : '60');
    setDriverActivityRefresh(settings.driver_activity_refresh !== '0');
    setAutoGeocodeAddress(settings.auto_geocode_address === '1');
    setIncludeOfflineDriversOnMap(settings.include_offline_drivers_on_map !== '0');
    setHidePickupTasks(settings.hide_pickup_tasks === '1');
    setHideDeliveryTasks(settings.hide_delivery_tasks === '1');
    setHideSuccessfulTasks(settings.hide_successful_tasks === '1');
    setGoogleMapStyle(settings.google_map_style != null ? String(settings.google_map_style) : '');
  }, [settings.allow_all_admin_team_by_merchant, settings.set_certain_merchant_admin_team, settings.admin_team_merchant_ids, settings.task_owner, settings.merchant_task_owner_admin_ids, settings.admin_show_only_admin_task, settings.do_not_allow_merchant_delete_task, settings.merchant_delete_task_days, settings.block_merchant_ids, settings.allow_task_successful_when, settings.order_status_accepted, settings.order_status_cancel, settings.delivery_time, settings.hide_total_order_amount, settings.app_name, settings.send_push_only_online_driver, settings.enabled_notes, settings.enabled_signature, settings.mandatory_signature, settings.enabled_signup, settings.enabled_add_photo_take_picture, settings.enabled_resize_picture, settings.resize_picture_width, settings.resize_picture_height, settings.device_vibration, settings.signup_status, settings.signup_notification_emails, settings.localize_calendar_language, settings.driver_tracking_option, settings.records_driver_location, settings.disabled_tracking, settings.track_interval, settings.task_critical_options_enabled, settings.task_critical_options_minutes, settings.privacy_policy_link, settings.language, settings.default_map_country, settings.disable_activity_tracking, settings.activity_refresh_interval, settings.driver_activity_refresh, settings.auto_geocode_address, settings.include_offline_drivers_on_map, settings.hide_pickup_tasks, settings.hide_delivery_tasks, settings.hide_successful_tasks, settings.google_map_style]);

  const handleGeneralSubmit = (e) => {
    e.preventDefault();
    setMessage(null);
    setSaving(true);
    const form = e.target;
    const payload = {
      website_title: String(form.website_title?.value ?? '').trim(),
      mobile_api_url: String(form.mobile_api_url?.value ?? '').trim(),
      api_hash_key: String(form.api_hash_key?.value ?? '').trim(),
      app_default_language: form.app_default_language?.value || 'en',
      language: language || 'en',
      force_default_language: form.force_default_language?.checked ? '1' : '0',
      allow_all_admin_team_by_merchant: allowAllAdminTeam ? '1' : '0',
      set_certain_merchant_admin_team: setCertainMerchantAdminTeam ? '1' : '0',
      admin_team_merchant_ids: Array.isArray(adminTeamMerchantIds) ? adminTeamMerchantIds : [],
      task_owner: taskOwner === 'merchant' ? 'merchant' : 'admin',
      merchant_task_owner_admin_ids: Array.isArray(merchantTaskOwnerAdminIds) ? merchantTaskOwnerAdminIds : [],
      admin_show_only_admin_task: adminShowOnlyAdminTask ? '1' : '0',
      do_not_allow_merchant_delete_task: doNotAllowMerchantDeleteTask ? '1' : '0',
      merchant_delete_task_days: String(merchantDeleteTaskDays ?? '').trim(),
      block_merchant_ids: Array.isArray(blockMerchantIds) ? blockMerchantIds : [],
      allow_task_successful_when: allowTaskSuccessfulWhen || 'picture_proof',
      order_status_accepted: Array.isArray(orderStatusAccepted) ? orderStatusAccepted : [],
      order_status_cancel: orderStatusCancel || 'Cancel',
      delivery_time: String(deliveryTime ?? '').trim(),
      hide_total_order_amount: hideTotalOrderAmount ? '1' : '0',
      app_name: String(appName ?? '').trim(),
      send_push_only_online_driver: sendPushOnlyOnlineDriver ? '1' : '0',
      enabled_notes: enabledNotes ? '1' : '0',
      enabled_signature: enabledSignature ? '1' : '0',
      mandatory_signature: mandatorySignature ? '1' : '0',
      enabled_signup: enabledSignup ? '1' : '0',
      enabled_add_photo_take_picture: enabledAddPhotoTakePicture ? '1' : '0',
      enabled_resize_picture: enabledResizePicture ? '1' : '0',
      resize_picture_width: String(resizePictureWidth ?? '').trim() || '500',
      resize_picture_height: String(resizePictureHeight ?? '').trim() || '600',
      device_vibration: String(deviceVibration ?? '').trim() || '3000',
      signup_status: signupStatus || 'active',
      signup_notification_emails: String(signupNotificationEmails ?? '').trim(),
      localize_calendar_language: localizeCalendarLanguage || 'en',
      driver_tracking_option: driverTrackingOption === '2' ? '2' : '1',
      records_driver_location: recordsDriverLocation ? '1' : '0',
      disabled_tracking: disabledTracking ? '1' : '0',
      track_interval: String(trackInterval ?? '').trim() || '10',
      task_critical_options_enabled: taskCriticalOptionsEnabled ? '1' : '0',
      task_critical_options_minutes: String(taskCriticalOptionsMinutes ?? '').trim() || '5',
      privacy_policy_link: String(privacyPolicyLink ?? '').trim(),
    };
    api('settings', { method: 'PUT', body: JSON.stringify(payload) })
      .then(() => { setMessage('Settings saved.'); fetchSettings(); })
      .catch((err) => setMessage((err && (err.error || err.message)) || 'Failed to save'))
      .finally(() => setSaving(false));
  };

  const handleMapKeysSubmit = (e) => {
    e.preventDefault();
    setMessage(null);
    setSaving(true);
    const form = e.target;
    const mapProviderValue = (form.map_provider?.value ?? settings.map_provider ?? 'mapbox').toString().trim().toLowerCase();
    const payload = {
      google_api_key: form.google_api_key?.value?.trim() || undefined,
      mapbox_access_token: form.mapbox_access_token?.value?.trim() || undefined,
      map_provider: mapProviderValue === 'google' ? 'google' : 'mapbox',
    };
    api('settings', { method: 'PUT', body: JSON.stringify(payload) })
      .then(() => {
        setMessage('Map API keys saved.');
        return api('settings');
      })
      .then((next) => {
        setSettings(next);
      })
      .catch((err) => setMessage((err && (err.error || err.message)) || 'Failed to save'))
      .finally(() => setSaving(false));
  };

  const handleFcmFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) {
      setFcmFile('');
      setFcmServiceAccountJson(null);
      return;
    }
    setFcmFile(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result;
        if (typeof text === 'string') setFcmServiceAccountJson(text);
        else setFcmServiceAccountJson(null);
      } catch {
        setFcmServiceAccountJson(null);
      }
    };
    reader.readAsText(file);
  };

  const handleFcmSubmit = (e) => {
    e.preventDefault();
    setMessage(null);
    setSaving(true);
    const form = e.target;
    const payload = {
      fcm_server_key: form.fcm_server_key?.value?.trim() || undefined,
    };
    if (fcmServiceAccountJson && fcmServiceAccountJson.trim()) {
      payload.fcm_service_account_json = fcmServiceAccountJson.trim();
    }
    api('settings', { method: 'PUT', body: JSON.stringify(payload) })
      .then(() => {
        setMessage('FCM settings saved.');
        setFcmServiceAccountJson(null);
        setFcmFile('');
        fetchSettings();
      })
      .catch((err) => setMessage((err && (err.error || err.message)) || 'Failed to save'))
      .finally(() => setSaving(false));
  };

  const addAdminTeamMerchant = (id) => {
    const n = Number(id);
    if (!Number.isNaN(n) && !adminTeamMerchantIds.includes(n)) setAdminTeamMerchantIds((prev) => [...prev, n]);
  };
  const removeAdminTeamMerchant = (id) => setAdminTeamMerchantIds((prev) => prev.filter((x) => x !== id));
  const addMerchantTaskOwner = (id) => {
    const n = Number(id);
    if (!Number.isNaN(n) && !merchantTaskOwnerAdminIds.includes(n)) setMerchantTaskOwnerAdminIds((prev) => [...prev, n]);
  };
  const removeMerchantTaskOwner = (id) => setMerchantTaskOwnerAdminIds((prev) => prev.filter((x) => x !== id));
  const addBlockMerchant = (id) => {
    const n = Number(id);
    if (!Number.isNaN(n) && !blockMerchantIds.includes(n)) setBlockMerchantIds((prev) => [...prev, n]);
  };
  const removeBlockMerchant = (id) => setBlockMerchantIds((prev) => prev.filter((x) => x !== id));
  const addOrderStatusAccepted = (status) => {
    if (status && !orderStatusAccepted.includes(status)) setOrderStatusAccepted((prev) => [...prev, status]);
  };
  const removeOrderStatusAccepted = (status) => setOrderStatusAccepted((prev) => prev.filter((s) => s !== status));

  const merchantName = (id) => {
    const m = merchants.find((x) => (x.merchant_id ?? x.id) === id);
    if (!m) return `Merchant ${id}`;
    return sanitizeMerchantDisplayName(m.restaurant_name) || `Merchant ${id}`;
  };

  const handleOtherSave = () => {
    setMessage('This section is not yet connected to the backend.');
    setTimeout(() => setMessage(null), 3000);
  };

  const handleMapSettingsSave = () => {
    setMessage(null);
    setSaving(true);
    const payload = {
      default_map_country: defaultMapCountry || 'ph',
      disable_activity_tracking: disableActivityTracking ? '1' : '0',
      activity_refresh_interval: String(activityRefreshInterval.trim() || '60'),
      driver_activity_refresh: driverActivityRefresh ? '1' : '0',
      auto_geocode_address: autoGeocodeAddress ? '1' : '0',
      include_offline_drivers_on_map: includeOfflineDriversOnMap ? '1' : '0',
      hide_pickup_tasks: hidePickupTasks ? '1' : '0',
      hide_delivery_tasks: hideDeliveryTasks ? '1' : '0',
      hide_successful_tasks: hideSuccessfulTasks ? '1' : '0',
      google_map_style: typeof googleMapStyle === 'string' ? googleMapStyle.trim() : '',
    };
    api('settings', { method: 'PUT', body: JSON.stringify(payload) })
      .then(() => {
        setMessage('Map settings saved.');
        fetchSettings();
      })
      .catch((err) => setMessage((err && (err.error || err.message)) || 'Failed to save'))
      .finally(() => setSaving(false));
  };

  if (loading) return <div className="page"><div className="loading">Loading…</div></div>;

  return (
    <div className="page settings-page">
      <div className="settings-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => { setActiveTab(tab.id); setMessage(null); }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="settings-content">
        {message && (activeTab === 'general' || activeTab === 'cron' || activeTab === 'update-db') && (
          <p className={message.includes('saved') || message.includes('Settings saved') || message.startsWith('OK') ? 'settings-message success' : 'settings-message error'} style={{ marginBottom: '1rem' }}>{message}</p>
        )}
        {activeTab === 'general' && (
          <form onSubmit={handleGeneralSubmit}>
            <div className="settings-section">
              <h2 className="settings-section-title">General</h2>
              <div className="settings-form-row">
                <label htmlFor="website_title">Website title</label>
                <div className="settings-field">
                  <input id="website_title" name="website_title" type="text" className="form-control" defaultValue={settings.website_title} />
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="mobile_api_url">Mobile API URL</label>
                <div className="settings-field">
                  <input id="mobile_api_url" name="mobile_api_url" type="url" className="form-control" defaultValue={settings.mobile_api_url} disabled />
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="api_hash_key">API hash key</label>
                <div className="settings-field">
                  <input id="api_hash_key" name="api_hash_key" type="text" className="form-control" defaultValue={settings.api_hash_key} />
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Language</h2>
              <div className="settings-form-row">
                <label htmlFor="language">Language</label>
                <div className="settings-field">
                  <select id="language" name="language" className="form-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                    <option value="en">English</option>
                    <option value="fil">Filipino</option>
                  </select>
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="app_default_language">App default language</label>
                <div className="settings-field">
                  <select id="app_default_language" name="app_default_language" className="form-control" defaultValue={settings.app_default_language || 'en'}>
                    <option value="en">English</option>
                    <option value="fil">Filipino</option>
                  </select>
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="force_default_language">Force default language</label>
                <div className="settings-field">
                  <label className="settings-checkbox-label">
                    <input type="checkbox" id="force_default_language" name="force_default_language" defaultChecked={settings.force_default_language === '1'} />
                    <span>Force default language</span>
                  </label>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Team Management</h2>
              <div className="settings-form-row">
                <label>Allow all Admin team to use by merchant</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${allowAllAdminTeam ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setAllowAllAdminTeam((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setAllowAllAdminTeam((v) => !v)}
                  />
                </div>
              </div>
              <div className="settings-form-row">
                <label>Set Certain Merchant to use admin Team</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${setCertainMerchantAdminTeam ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setSetCertainMerchantAdminTeam((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setSetCertainMerchantAdminTeam((v) => !v)}
                  />
                  <p className="settings-helper">If this is enabled, Allow all Admin team to use by merchant will be ignored.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Choose merchant</label>
                <div className="settings-field">
                  <div className="settings-tags-wrap">
                    {adminTeamMerchantIds.map((id) => (
                      <span key={id} className="settings-tag">
                        {merchantName(id)}
                        <button type="button" className="settings-tag-remove" onClick={() => removeAdminTeamMerchant(id)} aria-label="Remove">×</button>
                      </span>
                    ))}
                  </div>
                  <SearchableMerchantSelect
                    merchants={merchants}
                    excludedIds={adminTeamMerchantIds}
                    onSelect={addAdminTeamMerchant}
                    aria-label="Add merchant"
                  />
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Task Management</h2>
              <div className="settings-form-row">
                <label htmlFor="task_owner">Task Owner</label>
                <div className="settings-field">
                  <select
                    id="task_owner"
                    className="form-control"
                    value={taskOwner}
                    onChange={(e) => setTaskOwner(e.target.value)}
                  >
                    <option value="admin">admin</option>
                    <option value="merchant">merchant</option>
                  </select>
                  <p className="settings-helper">The owner of the task when merchant accept the order.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Set Merchant task owner to admin</label>
                <div className="settings-field">
                  <div className="settings-tags-wrap">
                    {merchantTaskOwnerAdminIds.map((id) => (
                      <span key={id} className="settings-tag">
                        {merchantName(id)}
                        <button type="button" className="settings-tag-remove" onClick={() => removeMerchantTaskOwner(id)} aria-label="Remove">×</button>
                      </span>
                    ))}
                  </div>
                  <SearchableMerchantSelect
                    merchants={merchants}
                    excludedIds={merchantTaskOwnerAdminIds}
                    onSelect={addMerchantTaskOwner}
                    aria-label="Add merchant"
                  />
                  <p className="settings-helper">Merchant list that admin will receive the task.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Admin user show only admin task</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${adminShowOnlyAdminTask ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setAdminShowOnlyAdminTask((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setAdminShowOnlyAdminTask((v) => !v)}
                  />
                  <p className="settings-helper">Show only task that belongs to admin user.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Do Not allow merchant to delete the task</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${doNotAllowMerchantDeleteTask ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setDoNotAllowMerchantDeleteTask((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setDoNotAllowMerchantDeleteTask((v) => !v)}
                  />
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="merchant_delete_task_days">No.s of days allowed for merchant to delete the task</label>
                <div className="settings-field">
                  <input
                    id="merchant_delete_task_days"
                    type="number"
                    min="0"
                    className="form-control"
                    value={merchantDeleteTaskDays}
                    onChange={(e) => setMerchantDeleteTaskDays(e.target.value)}
                    style={{ maxWidth: '100px' }}
                  />
                  <p className="settings-helper">Nos. of days After task was created.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Block merchant</label>
                <div className="settings-field">
                  <div className="settings-tags-wrap">
                    {blockMerchantIds.map((id) => (
                      <span key={id} className="settings-tag">
                        {merchantName(id)}
                        <button type="button" className="settings-tag-remove" onClick={() => removeBlockMerchant(id)} aria-label="Remove">×</button>
                      </span>
                    ))}
                  </div>
                  <select
                    className="form-control settings-select-add"
                    value=""
                    onChange={(e) => { addBlockMerchant(e.target.value); e.target.value = ''; }}
                    aria-label="Add merchant"
                  >
                    <option value="">Select Some Options</option>
                    {merchants.filter((m) => !blockMerchantIds.includes(m.merchant_id ?? m.id)).map((m) => (
                      <option key={m.merchant_id ?? m.id} value={m.merchant_id ?? m.id}>{sanitizeMerchantDisplayName(m.restaurant_name) || `Merchant ${m.merchant_id ?? m.id}`}</option>
                    ))}
                  </select>
                  <p className="settings-helper">List of merchant that cannot access driver panel.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="allow_task_successful_when">Allow only task to successful when</label>
                <div className="settings-field">
                  <select
                    id="allow_task_successful_when"
                    className="form-control"
                    value={allowTaskSuccessfulWhen}
                    onChange={(e) => setAllowTaskSuccessfulWhen(e.target.value)}
                  >
                    <option value="picture_proof">Added picture proof of delivery</option>
                    <option value="marked_complete">Task marked complete</option>
                    <option value="any">Any</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Task Critical Options</h2>
              <p className="settings-helper" style={{ marginBottom: '1rem' }}>Set critical background color to the task when its unassigned after a set of minutes.</p>
              <div className="settings-form-row">
                <label>Enabled</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${taskCriticalOptionsEnabled ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setTaskCriticalOptionsEnabled((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setTaskCriticalOptionsEnabled((v) => !v)}
                  />
                  <span className="settings-toggle-label">{taskCriticalOptionsEnabled ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="task_critical_options_minutes">Minutes</label>
                <div className="settings-field">
                  <input
                    id="task_critical_options_minutes"
                    type="number"
                    min="1"
                    className="form-control"
                    value={taskCriticalOptionsMinutes}
                    onChange={(e) => setTaskCriticalOptionsMinutes(e.target.value)}
                    style={{ maxWidth: '100px' }}
                  />
                  <p className="settings-helper">Default is 5 minutes.</p>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Privacy policy</h2>
              <div className="settings-form-row">
                <label htmlFor="privacy_policy_link">Link</label>
                <div className="settings-field">
                  <input
                    id="privacy_policy_link"
                    type="url"
                    className="form-control"
                    value={privacyPolicyLink}
                    onChange={(e) => setPrivacyPolicyLink(e.target.value)}
                    placeholder="https://example.com/privacy-policy"
                  />
                  <p className="settings-helper">Your privacy policy website link.</p>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Order Settings</h2>
              <div className="settings-form-row">
                <label>Order status that creates task</label>
                <div className="settings-field">
                  <div className="settings-tags-wrap">
                    {orderStatusAccepted.map((status) => (
                      <span key={status} className="settings-tag">
                        {status}
                        <button type="button" className="settings-tag-remove" onClick={() => removeOrderStatusAccepted(status)} aria-label="Remove">×</button>
                      </span>
                    ))}
                  </div>
                  <select
                    className="form-control settings-select-add"
                    value=""
                    onChange={(e) => { addOrderStatusAccepted(e.target.value); e.target.value = ''; }}
                    aria-label="Add order status"
                  >
                    <option value="">Select Some Options</option>
                    {ORDER_STATUS_ACCEPTED_OPTIONS.filter((s) => !orderStatusAccepted.includes(s)).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <p className="settings-helper">The order status that will based to insert the order as task.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="order_status_cancel">Order Status Cancel</label>
                <div className="settings-field">
                  <select
                    id="order_status_cancel"
                    className="form-control"
                    value={orderStatusCancel}
                    onChange={(e) => setOrderStatusCancel(e.target.value)}
                  >
                    <option value="Cancel">Cancel</option>
                    <option value="Cancelled">Cancelled</option>
                    <option value="Canceled">Canceled</option>
                    <option value="Rejected">Rejected</option>
                  </select>
                  <p className="settings-helper">The order status when merchant cancel the order.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="delivery_time">Delivery time display option</label>
                <div className="settings-field">
                  <select
                    id="delivery_time"
                    className="form-control"
                    value={deliveryTime}
                    onChange={(e) => setDeliveryTime(e.target.value)}
                  >
                    <option value="">Please select</option>
                    <option value="asap">ASAP</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="30">30 mins</option>
                    <option value="60">60 mins</option>
                    <option value="90">90 mins</option>
                  </select>
                  <p className="settings-helper">How delivery time is shown (ASAP, scheduled, or offset in minutes).</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Hide Total Order amount</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${hideTotalOrderAmount ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setHideTotalOrderAmount((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setHideTotalOrderAmount((v) => !v)}
                  />
                  <span className="settings-toggle-label">{hideTotalOrderAmount ? 'ON' : 'OFF'}</span>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">App Settings</h2>
              <div className="settings-form-row">
                <label htmlFor="app_name">App Name</label>
                <div className="settings-field">
                  <input
                    id="app_name"
                    type="text"
                    className="form-control"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                  />
                </div>
              </div>
              <div className="settings-form-row">
                <label>Send Push only to online driver</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${sendPushOnlyOnlineDriver ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setSendPushOnlyOnlineDriver((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setSendPushOnlyOnlineDriver((v) => !v)}
                  />
                  <span className="settings-toggle-label">{sendPushOnlyOnlineDriver ? 'ON' : 'OFF'}</span>
                  <p className="settings-helper">Send push notification only to online drivers when assigning task.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Enabled Notes</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${enabledNotes ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setEnabledNotes((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setEnabledNotes((v) => !v)}
                  />
                  <span className="settings-toggle-label">{enabledNotes ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Enabled Signature</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${enabledSignature ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setEnabledSignature((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setEnabledSignature((v) => !v)}
                  />
                  <span className="settings-toggle-label">{enabledSignature ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Mandatory Signature</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${mandatorySignature ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setMandatorySignature((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setMandatorySignature((v) => !v)}
                  />
                  <span className="settings-toggle-label">{mandatorySignature ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Enabled Signup</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${enabledSignup ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setEnabledSignup((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setEnabledSignup((v) => !v)}
                  />
                  <span className="settings-toggle-label">{enabledSignup ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Enabled Add Photo/Take Picture</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${enabledAddPhotoTakePicture ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setEnabledAddPhotoTakePicture((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setEnabledAddPhotoTakePicture((v) => !v)}
                  />
                  <span className="settings-toggle-label">{enabledAddPhotoTakePicture ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Enabled Resize Picture</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${enabledResizePicture ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setEnabledResizePicture((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setEnabledResizePicture((v) => !v)}
                  />
                  <span className="settings-toggle-label">{enabledResizePicture ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="resize_picture_width">Resize picture</label>
                <div className="settings-field">
                  <div className="settings-field-inline">
                    <input
                      id="resize_picture_width"
                      type="number"
                      min="1"
                      className="form-control"
                      value={resizePictureWidth}
                      onChange={(e) => setResizePictureWidth(e.target.value)}
                      style={{ maxWidth: '80px' }}
                    />
                    <span aria-hidden>×</span>
                    <input
                      id="resize_picture_height"
                      type="number"
                      min="1"
                      className="form-control"
                      value={resizePictureHeight}
                      onChange={(e) => setResizePictureHeight(e.target.value)}
                      style={{ maxWidth: '80px' }}
                    />
                  </div>
                  <p className="settings-helper">Resize picture during taking picture in the app.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="device_vibration">Device Vibration</label>
                <div className="settings-field">
                  <input
                    id="device_vibration"
                    type="number"
                    min="0"
                    className="form-control"
                    value={deviceVibration}
                    onChange={(e) => setDeviceVibration(e.target.value)}
                    style={{ maxWidth: '100px' }}
                  />
                  <p className="settings-helper">Default is 3000. Vibrate for 3 seconds.</p>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Driver Signup Settings</h2>
              <div className="settings-form-row">
                <label htmlFor="signup_status">Set Signup Status</label>
                <div className="settings-field">
                  <select
                    id="signup_status"
                    className="form-control"
                    value={signupStatus}
                    onChange={(e) => setSignupStatus(e.target.value)}
                  >
                    <option value="active">active</option>
                    <option value="pending">pending</option>
                    <option value="inactive">inactive</option>
                  </select>
                  <p className="settings-helper">Set the default status of the driver after signup.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="signup_notification_emails">Signup - Send Notification Email To</label>
                <div className="settings-field">
                  <input
                    id="signup_notification_emails"
                    type="text"
                    className="form-control"
                    value={signupNotificationEmails}
                    onChange={(e) => setSignupNotificationEmails(e.target.value)}
                    placeholder="Email address that will receive email once there is new signup"
                  />
                  <p className="settings-helper">Multiple email must separated by comma.</p>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Localize Calendar</h2>
              <div className="settings-form-row">
                <label htmlFor="localize_calendar_language">Language</label>
                <div className="settings-field">
                  <select
                    id="localize_calendar_language"
                    className="form-control"
                    value={localizeCalendarLanguage}
                    onChange={(e) => setLocalizeCalendarLanguage(e.target.value)}
                  >
                    <option value="en">English</option>
                    <option value="fil">Filipino</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Driver Tracking Options</h2>
              <p className="settings-helper" style={{ marginBottom: '1rem' }}>Determine the driver online and offline status.</p>
              <div className="settings-form-row">
                <label>Tracking Options 1</label>
                <div className="settings-field">
                  <label className="settings-radio-label">
                    <input
                      type="radio"
                      name="driver_tracking_option"
                      checked={driverTrackingOption === '1'}
                      onChange={() => setDriverTrackingOption('1')}
                    />
                    <span>This options will set the driver online when the device sents location to server.</span>
                  </label>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Tracking Options 2</label>
                <div className="settings-field">
                  <label className="settings-radio-label">
                    <input
                      type="radio"
                      name="driver_tracking_option"
                      checked={driverTrackingOption === '2'}
                      onChange={() => setDriverTrackingOption('2')}
                    />
                    <span>This options will set the driver only offline when they logout to the app or set to off duty and idle for more than 30min.</span>
                  </label>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Records Driver Location</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${recordsDriverLocation ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setRecordsDriverLocation((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setRecordsDriverLocation((v) => !v)}
                  />
                  <span className="settings-toggle-label">{recordsDriverLocation ? 'ON' : 'OFF'}</span>
                  <p className="settings-helper">This will save driver locations for later review.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Disabled Tracking</label>
                <div className="settings-field">
                  <div
                    role="button"
                    className={`settings-toggle ${disabledTracking ? 'on' : ''}`}
                    tabIndex={0}
                    aria-label="Toggle"
                    onClick={() => setDisabledTracking((v) => !v)}
                    onKeyDown={(e) => e.key === 'Enter' && setDisabledTracking((v) => !v)}
                  />
                  <span className="settings-toggle-label">{disabledTracking ? 'ON' : 'OFF'}</span>
                  <p className="settings-helper">This options will not track your agents.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label htmlFor="track_interval">Track Interval</label>
                <div className="settings-field">
                  <input
                    id="track_interval"
                    type="number"
                    min="1"
                    className="form-control"
                    value={trackInterval}
                    onChange={(e) => setTrackInterval(e.target.value)}
                    style={{ maxWidth: '100px' }}
                  />
                  <p className="settings-helper">In seconds, Default is 10 seconds.</p>
                </div>
              </div>
            </div>

            {message && activeTab === 'general' && <p className={message.includes('saved') ? 'settings-message success' : 'settings-message error'}>{message}</p>}
            <button type="submit" className="btn-save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </form>
        )}

        {activeTab === 'map-keys' && (
          <form onSubmit={handleMapKeysSubmit}>
            <p className="settings-helper" style={{ marginBottom: '1.25rem' }}>
              Choose which map to show on the dashboard and add the matching API key below. Save, then open the dashboard to see the map.
            </p>
            <div className="settings-section">
              <div className="settings-form-row">
                <label htmlFor="map_provider">Map provider</label>
                <div className="settings-field">
                  <select
                    id="map_provider"
                    name="map_provider"
                    className="form-control"
                    value={settings.map_provider === 'google' ? 'google' : 'mapbox'}
                    onChange={(e) => setSettings((prev) => ({ ...prev, map_provider: e.target.value }))}
                    aria-label="Map provider"
                  >
                    <option value="mapbox">Mapbox</option>
                    <option value="google">Google Maps</option>
                  </select>
                  <p className="settings-helper">Which map to display on the Dashboard. For Mapbox, paste your token below and click Save.</p>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Google Maps</h2>
              <div className="settings-form-row">
                <label htmlFor="google_api_key">Google API key</label>
                <div className="settings-field">
                  <input id="google_api_key" name="google_api_key" type="text" className="form-control" defaultValue={settings.google_api_key} placeholder="e.g. AIzaSy..." />
                  <p className="settings-helper">Enable Google Maps JavaScript API, Geocoding API and Distance Matrix API in your Google Cloud Console. Required for the dashboard map.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Enabled cURL</label>
                <div className="settings-field">
                  <div role="button" className="settings-toggle" tabIndex={0} aria-label="Toggle" onClick={(e) => e.currentTarget.classList.toggle('on')}> </div>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <h2 className="settings-section-title">Mapbox</h2>
              <div className="settings-form-row">
                <label htmlFor="mapbox_access_token">Mapbox access token</label>
                <div className="settings-field">
                  <input id="mapbox_access_token" name="mapbox_access_token" type="text" className="form-control" defaultValue={settings.mapbox_access_token} placeholder="pk.eyJ1..." autoComplete="off" />
                  <p className="settings-helper">Use Mapbox if you don’t use Google. Get one at <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noopener noreferrer" className="settings-link">mapbox.com</a>. Select Mapbox above, paste the token, then Save. If the map does not load, allow this site URL in Mapbox Studio.</p>
                </div>
              </div>
            </div>
            {message && activeTab === 'map-keys' && <p className={message.includes('saved') ? 'settings-message success' : 'settings-message error'}>{message}</p>}
            <button type="submit" className="btn-save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </form>
        )}

        {activeTab === 'fcm' && (
          <form onSubmit={handleFcmSubmit}>
            <div className="settings-section">
              <div className="settings-form-row">
                <label htmlFor="fcm_server_key">Server key (legacy)</label>
                <div className="settings-field">
                  <input id="fcm_server_key" name="fcm_server_key" type="text" className="form-control" defaultValue={settings.fcm_server_key} placeholder="AAAAS5pwqSk:APA91b..." style={{ maxWidth: '100%' }} />
                </div>
              </div>
              <div className="settings-form-row">
                <label>Service account key (JSON)</label>
                <div className="settings-field">
                  <div className="settings-field-inline">
                    <button type="button" className="btn-browse" onClick={() => document.getElementById('fcm_file').click()}>Browse</button>
                    <input type="text" readOnly className="form-control" placeholder={settings.fcm_service_account_configured ? '••• configured (upload new to replace)' : 'No file chosen'} value={fcmFile} style={{ flex: 1 }} />
                    <input id="fcm_file" type="file" accept=".json" style={{ display: 'none' }} onChange={handleFcmFileChange} />
                  </div>
                  <p className="settings-helper">
                    <a href="https://firebase.google.com/docs/admin/setup" target="_blank" rel="noopener noreferrer" className="settings-link">How to get your Service accounts private key</a>
                    {'. '}Stored in database. Upload a new file to replace.
                  </p>
                </div>
              </div>
            </div>
            {message && activeTab === 'fcm' && <p className={message.includes('saved') ? 'settings-message success' : 'settings-message error'}>{message}</p>}
            <button type="submit" className="btn-save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </form>
        )}

        {activeTab === 'map-settings' && (
          <>
            {message && activeTab === 'map-settings' && <p className={message.includes('saved') ? 'settings-message success' : 'settings-message error'} style={{ marginBottom: '1rem' }}>{message}</p>}
            <div className="settings-section">
              <div className="settings-form-row">
                <label>Default map country</label>
                <div className="settings-field">
                  <select className="form-control" value={defaultMapCountry} onChange={(e) => setDefaultMapCountry(e.target.value)}>
                    <option value="ph">Philippines</option>
                  </select>
                  <p className="settings-helper">Set the default country for the map.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Disable activity tracking</label>
                <div className="settings-field">
                  <div role="button" className={`settings-toggle ${disableActivityTracking ? 'on' : ''}`} tabIndex={0} aria-label="Toggle" onClick={() => setDisableActivityTracking((v) => !v)}> </div>
                  <span className="settings-toggle-label">{disableActivityTracking ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Activity refresh interval</label>
                <div className="settings-field">
                  <input type="number" className="form-control" value={activityRefreshInterval} onChange={(e) => setActivityRefreshInterval(e.target.value)} min={5} max={600} style={{ maxWidth: '80px' }} />
                  <p className="settings-helper">In seconds (default 60).</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Driver activity refresh</label>
                <div className="settings-field">
                  <div role="button" className={`settings-toggle ${driverActivityRefresh ? 'on' : ''}`} tabIndex={0} aria-label="Toggle" onClick={() => setDriverActivityRefresh((v) => !v)}> </div>
                  <span className="settings-toggle-label">{driverActivityRefresh ? 'ON' : 'OFF'}</span>
                  <p className="settings-helper">Map/dashboard will refresh if there is driver activity</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Auto geocode address</label>
                <div className="settings-field">
                  <div role="button" className={`settings-toggle ${autoGeocodeAddress ? 'on' : ''}`} tabIndex={0} aria-label="Toggle" onClick={() => setAutoGeocodeAddress((v) => !v)}> </div>
                  <span className="settings-toggle-label">{autoGeocodeAddress ? 'ON' : 'OFF'}</span>
                  <p className="settings-helper">Auto fill address after dragging the marker on map only for Google Maps.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Include offline drivers on map</label>
                <div className="settings-field">
                  <div role="button" className={`settings-toggle ${includeOfflineDriversOnMap ? 'on' : ''}`} tabIndex={0} aria-label="Toggle" onClick={() => setIncludeOfflineDriversOnMap((v) => !v)}> </div>
                  <span className="settings-toggle-label">{includeOfflineDriversOnMap ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Dashboard map — merchant filter</label>
                <div className="settings-field">
                  <MapMerchantFilter options={merchants} className="map-merchant-filter--settings" />
                  <p className="settings-helper">
                    Limits which merchant pins and matching on-duty riders appear on the main Dashboard map. Saved in this browser session only (not the Save button below).
                  </p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Hide pickup tasks</label>
                <div className="settings-field">
                  <div role="button" className={`settings-toggle ${hidePickupTasks ? 'on' : ''}`} tabIndex={0} aria-label="Toggle" onClick={() => setHidePickupTasks((v) => !v)}> </div>
                  <span className="settings-toggle-label">{hidePickupTasks ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Hide delivery tasks</label>
                <div className="settings-field">
                  <div role="button" className={`settings-toggle ${hideDeliveryTasks ? 'on' : ''}`} tabIndex={0} aria-label="Toggle" onClick={() => setHideDeliveryTasks((v) => !v)}> </div>
                  <span className="settings-toggle-label">{hideDeliveryTasks ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Hide successful tasks</label>
                <div className="settings-field">
                  <div role="button" className={`settings-toggle ${hideSuccessfulTasks ? 'on' : ''}`} tabIndex={0} aria-label="Toggle" onClick={() => setHideSuccessfulTasks((v) => !v)}> </div>
                  <span className="settings-toggle-label">{hideSuccessfulTasks ? 'ON' : 'OFF'}</span>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Google Map style</label>
                <div className="settings-field">
                  <textarea className="form-control" value={googleMapStyle} onChange={(e) => setGoogleMapStyle(e.target.value)} placeholder='[{"featureType":"all","elementType":"all","stylers":[{"saturation":"32"},{"lightness":"3"}]}]' style={{ minHeight: 140, fontFamily: 'monospace', fontSize: '0.8rem' }} />
                  <p className="settings-helper">Set the style of your map, get it on https://snazzymaps.com leave it empty if you are unsure.</p>
                </div>
              </div>
            </div>
            <button type="button" className="btn-save" onClick={handleMapSettingsSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </>
        )}

        {activeTab === 'cron' && (
          <>
            <div className="settings-section">
              <h2 className="settings-section-title">Cron jobs</h2>
              <p className="settings-helper" style={{ marginBottom: '1rem' }}>
                Use a cron job (e.g. every 1–5 minutes) to call the health/auto-assign endpoint. This keeps unassigned task counts in sync and can trigger auto-assignment if you use an external scheduler.
              </p>
              <div className="settings-form-row">
                <label>Endpoint URL</label>
                <div className="settings-field">
                  <code className="settings-code">{typeof window !== 'undefined' ? `${window.location.origin}/api/cron/check` : '/api/cron/check'}</code>
                  <p className="settings-helper">Use your backend base URL in production, e.g. <code>https://your-server.com/admin/api/cron/check</code>. Call with GET; optional: add <code>x-admin-key</code> or <code>x-dashboard-token</code> if required.</p>
                </div>
              </div>
              <div className="settings-form-row">
                <label>Test connection</label>
                <div className="settings-field">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      setMessage(null);
                      try {
                        const res = await api('cron/check');
                        setMessage(`OK. Unassigned tasks: ${res.unassigned_tasks ?? 0}`);
                      } catch (err) {
                        setMessage((err && (err.error || err.message)) || 'Request failed');
                      }
                      setTimeout(() => setMessage(null), 5000);
                    }}
                  >
                    Test cron endpoint
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {activeTab === 'update-db' && (
          <>
            <div className="settings-section">
              <h2 className="settings-section-title">Update database</h2>
              <p className="settings-helper" style={{ marginBottom: '0.5rem' }}>
                Driver module DB updates (versioned). Apply schema changes from your backend or run migration scripts (e.g. <code>scripts/init-db.js</code>, <code>scripts/add-driver-tracking-columns.js</code>) with the correct <code>DB_NAME</code> and credentials.
              </p>
              <p className="settings-helper" style={{ marginTop: '0.5rem' }}>
                This dashboard does not run migrations automatically. Use your backend deployment or run <code>node -r dotenv/config scripts/init-db.js</code> (and any other migration scripts) when upgrading.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
