import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../api';

const STORAGE_KEY = 'wib-selected-team-id';

function getStoredTeamId() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function setStoredTeamId(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
}

const TeamFilterContext = createContext({
  teams: [],
  selectedTeamId: '',
  setSelectedTeamId: () => {},
});

export function TeamFilterProvider({ children }) {
  const [teams, setTeams] = useState([]);
  const [selectedTeamId, setSelectedTeamId] = useState(getStoredTeamId);

  useEffect(() => {
    api('teams')
      .then((list) => setTeams(Array.isArray(list) ? list : []))
      .catch(() => setTeams([]));
  }, []);

  useEffect(() => {
    if (teams.length === 0) return;
    const ids = new Set(teams.map((t) => String(t.id ?? t.team_id ?? '')));
    if (selectedTeamId && !ids.has(selectedTeamId)) {
      setSelectedTeamId('');
      setStoredTeamId('');
    }
  }, [teams]);

  const setSelectedTeamIdPersisted = useCallback((value) => {
    const id = String(value ?? '').trim();
    setSelectedTeamId(id);
    setStoredTeamId(id);
  }, []);

  return (
    <TeamFilterContext.Provider value={{ teams, selectedTeamId, setSelectedTeamId: setSelectedTeamIdPersisted }}>
      {children}
    </TeamFilterContext.Provider>
  );
}

export function useTeamFilter() {
  return useContext(TeamFilterContext);
}
