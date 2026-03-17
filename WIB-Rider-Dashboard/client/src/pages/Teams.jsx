import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, formatDate } from '../api';
import { useTableAutoRefresh } from '../hooks/useTableAutoRefresh';
import { useTablePagination, PAGE_SIZE_OPTIONS } from '../hooks/useTablePagination';
import { useTableSort } from '../hooks/useTableSort';
import TablePaginationControls from '../components/TablePaginationControls';
import TableSortControls from '../components/TableSortControls';

const TEAM_SORT_OPTIONS = [
  { key: 'id', label: 'ID', compare: (a, b) => (a.id ?? 0) - (b.id ?? 0) },
  { key: 'name', label: 'Team', compare: (a, b) => String(a.name ?? '').localeCompare(b.name ?? '') },
  { key: 'driver_count', label: 'Drivers', compare: (a, b) => (a.driver_count ?? 0) - (b.driver_count ?? 0) },
];

export default function Teams() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalTeam, setModalTeam] = useState(undefined);
  const [teamName, setTeamName] = useState('');
  const [saving, setSaving] = useState(false);
  const sortKey = searchParams.get('sort') || 'name';
  const sortOrder = searchParams.get('order') || 'asc';
  const urlPage = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  const urlSize = PAGE_SIZE_OPTIONS.includes(parseInt(searchParams.get('size'), 10)) ? parseInt(searchParams.get('size'), 10) : 10;

  const setSort = ({ sortKey: k, sortOrder: o }) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('sort', k);
      next.set('order', o || 'asc');
      next.set('page', '1');
      return next;
    });
  };
  const setPageAndUrl = (p) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('page', String(Math.max(1, p)));
      return next;
    });
  };
  const setPageSizeAndUrl = (s) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('size', String(s));
      next.set('page', '1');
      return next;
    });
  };

  const fetchTeams = () => {
    setLoading(true);
    api('teams').then(setTeams).catch(() => setTeams([])).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchTeams();
  }, []);

  useTableAutoRefresh(fetchTeams);

  const sortedTeams = useTableSort(teams || [], sortKey, sortOrder, TEAM_SORT_OPTIONS);
  const {
    paginatedItems: paginatedTeams,
    pageSize,
    setPageSize,
    currentPage,
    setCurrentPage,
    totalPages,
    totalItems,
    startRow,
    endRow,
  } = useTablePagination(sortedTeams, 10, {
    page: urlPage,
    pageSize: urlSize,
    onPageChange: setPageAndUrl,
    onPageSizeChange: setPageSizeAndUrl,
  });

  const openCreate = () => {
    setModalTeam(null);
    setTeamName('');
  };
  const openEdit = (t) => {
    setModalTeam(t);
    setTeamName(t.name ?? '');
  };
  const closeModal = () => {
    setModalTeam(undefined);
    setTeamName('');
  };

  const handleSaveTeam = (e) => {
    e.preventDefault();
    const name = (teamName || '').trim();
    if (!name) return;
    setSaving(true);
    if (modalTeam) {
      api(`teams/${modalTeam.id}`, { method: 'PUT', body: JSON.stringify({ name }) })
        .then(() => { closeModal(); fetchTeams(); })
        .catch((err) => alert(err?.error || err?.message || 'Failed to update team'))
        .finally(() => setSaving(false));
    } else {
      api('teams', { method: 'POST', body: JSON.stringify({ name }) })
        .then(() => { closeModal(); fetchTeams(); })
        .catch((err) => alert(err?.error || err?.message || 'Failed to create team'))
        .finally(() => setSaving(false));
    }
  };

  const handleDelete = (t) => {
    if (!window.confirm(`Delete team "${t.name ?? 'Team'}"? Drivers in this team will be unassigned (no longer linked to a team).`)) return;
    setSaving(true);
    api(`teams/${t.id}`, { method: 'DELETE' })
      .then(() => fetchTeams())
      .catch((err) => alert(err?.error || err?.message || 'Failed to delete team'))
      .finally(() => setSaving(false));
  };

  return (
    <div className="listing-section">
      <div className="listing-toolbar" style={{ marginBottom: '1rem' }}>
        <button type="button" className="btn btn-primary" onClick={openCreate}>
          Create team
        </button>
      </div>
      {loading && <div className="loading">Loading…</div>}
      {!loading && (
        <div className="listing-table-card">
          <TableSortControls
            sortOptions={TEAM_SORT_OPTIONS.map(({ key, label }) => ({ key, label }))}
            sortKey={sortKey}
            sortOrder={sortOrder}
            onSortChange={setSort}
          />
          <div className="listing-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Team</th>
                  <th>Drivers</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginatedTeams.map((t) => (
                  <tr key={t.id}>
                    <td>{t.id}</td>
                    <td>{t.name}</td>
                    <td>{t.driver_count ?? 0}</td>
                    <td>{t.status ?? '—'}</td>
                    <td>{formatDate(t.date_created)}</td>
                    <td>
                      <div className="table-actions">
                        <button type="button" className="btn btn-sm" onClick={() => openEdit(t)}>Edit</button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => handleDelete(t)} disabled={saving}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePaginationControls
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
            currentPage={currentPage}
            onPageChange={setCurrentPage}
            totalPages={totalPages}
            totalItems={totalItems}
            startRow={startRow}
            endRow={endRow}
          />
        </div>
      )}

      {modalTeam !== undefined ? (
        <div className="modal-backdrop" onClick={() => !saving && closeModal()}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{modalTeam ? 'Edit team' : 'Create team'}</h3>
              <button type="button" className="modal-close" onClick={() => !saving && closeModal()} aria-label="Close">×</button>
            </div>
            <form onSubmit={handleSaveTeam}>
              <div className="modal-body">
                <label className="modal-label" htmlFor="team-name">Team name</label>
                <input
                  id="team-name"
                  type="text"
                  className="form-control"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="e.g. Morning Shift"
                  required
                  autoFocus
                />
              </div>
              <div className="modal-footer-actions">
                <button type="button" className="btn" onClick={() => !saving && closeModal()} disabled={saving}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving || !(teamName || '').trim()}>{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
