import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { call } from '@/data/client';
import { qk, useFeelingTags, useProblemMutations, useTimerActions } from '@/data/queries';
import { ProblemDetail } from './ProblemDetail';

/** Opens the problem detail modal from any page. */
export function useProblemDetail(opts: { goToTodayOnStart?: boolean } = {}) {
  const [id, setId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { data: problem } = useQuery({
    queryKey: qk.problem(id ?? ''),
    queryFn: () => call('problem_get', { id: id! }),
    enabled: !!id,
  });
  const { data: feelings = [] } = useFeelingTags();
  const m = useProblemMutations();
  const timer = useTimerActions();

  const element =
    id && problem ? (
      <ProblemDetail
        problem={problem}
        feelings={feelings}
        onClose={() => setId(null)}
        onReveal={(what) => m.reveal.mutate({ id, what })}
        onStatus={(status) => m.setStatus.mutate({ id, status })}
        onFeeling={(fid) => m.update.mutate({ id, feeling_tag_id: fid })}
        onFlag={(flagged) => m.flag.mutate({ id, flagged })}
        onDone={async () => {
          if (problem.status !== 'solved' && problem.status !== 'solved_with_help')
            await m.setStatus.mutateAsync({ id, status: 'solved' });
          m.reveal.mutate({ id, what: 'answer' });
        }}
        onStart={() =>
          timer.attemptStart.mutate(id, {
            onSuccess: () => {
              setId(null);
              if (opts.goToTodayOnStart) navigate('/today');
            },
          })
        }
      />
    ) : null;

  return { open: setId, element };
}
