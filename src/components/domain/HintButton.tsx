import { useTranslation } from 'react-i18next';
import { LifeBuoy } from 'lucide-react';
import { Button, toast } from '@/components/ui';
import { useHintPrompt } from '@/data/queries';
import { copyText } from '@/data/platform';

/**
 * "I'm stuck": copies a prompt that asks ChatGPT / Gemini for hints only,
 * explained with the concepts the learner already knows. Never the solution.
 */
export function HintButton({ problemId, size = 'sm' }: { problemId: string; size?: 'sm' | 'md' }) {
  const { t } = useTranslation();
  const hint = useHintPrompt();
  return (
    <Button
      size={size}
      variant="ghost"
      icon={<LifeBuoy size={16} />}
      loading={hint.isPending}
      onClick={() =>
        hint.mutate(problemId, {
          onSuccess: async (prompt) => {
            await copyText(prompt);
            toast.info(t('hint.copied'));
          },
        })
      }
    >
      {t('hint.stuck')}
    </Button>
  );
}
