import { useNavigate } from 'react-router-dom';
import NewTaskModal from '../components/NewTaskModal';

export default function NewTask() {
  const navigate = useNavigate();

  return (
    <div className="new-task-backdrop">
      <NewTaskModal
        onClose={() => navigate('/')}
        onSuccess={() => navigate('/tasks')}
      />
    </div>
  );
}
