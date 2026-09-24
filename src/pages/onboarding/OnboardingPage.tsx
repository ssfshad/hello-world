import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router-dom';
import { Star } from 'lucide-react';
import { Button, Card, Chip, ChipGroup, IconButton, TextArea, TextField } from '@/components/ui';
import { useAppState, useOnboardingComplete } from '@/data/queries';
import { useApplyAppearance } from '@/app/guards';
import { onboardingSchema, type OnboardingForm } from '@/core/schemas';
import s from '../pages.module.css';

export const BUILTIN_LANGUAGES = [
  'Python',
  'JavaScript',
  'TypeScript',
  'Java',
  'C',
  'C++',
  'C#',
  'Go',
  'Rust',
  'Kotlin',
  'Swift',
  'PHP',
  'Ruby',
  'SQL',
  'HTML/CSS',
];

export default function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: app } = useAppState();
  useApplyAppearance(app?.settings);
  const complete = useOnboardingComplete();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<OnboardingForm>({
    display_name: '',
    languages: [],
    primary_language: '',
    daily_goal_min: 60,
    day_boundary: '04:00',
    letter: null,
  });
  const [other, setOther] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (app?.onboarding_done) return <Navigate to="/today" replace />;

  const allLangs = [...BUILTIN_LANGUAGES, ...form.languages.filter((l) => !BUILTIN_LANGUAGES.includes(l))];
  const toggleLang = (name: string) =>
    setForm((f) => {
      const on = f.languages.includes(name);
      const languages = on ? f.languages.filter((x) => x !== name) : [...f.languages, name];
      const primary = languages.includes(f.primary_language) ? f.primary_language : (languages[0] ?? '');
      return { ...f, languages, primary_language: primary };
    });

  const finish = (f: OnboardingForm) => {
    const filled: OnboardingForm = {
      ...f,
      display_name: f.display_name.trim() || 'Friend',
      languages: f.languages.length ? f.languages : ['Python'],
      primary_language: f.primary_language || f.languages[0] || 'Python',
      letter: f.letter?.trim() ? f.letter : null,
    };
    const parsed = onboardingSchema.safeParse(filled);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      setStep(parsed.error.issues.some((i) => ['display_name', 'languages'].includes(String(i.path[0]))) ? 1 : 2);
      return;
    }
    complete.mutate(parsed.data, { onSuccess: () => navigate('/dashboard', { replace: true }) });
  };

  const next = () => {
    if (step === 1) {
      const e: Record<string, string> = {};
      if (!form.display_name.trim()) e.display_name = 'errors.required';
      if (!form.languages.length) e.languages = 'errors.pickLanguage';
      setErrors(e);
      if (Object.keys(e).length) return;
    }
    if (step === 3) finish(form);
    else setStep(step + 1);
  };

  return (
    <main className={s.onboard}>
      <Card className={s.onboardCard}>
        <div className={s.steps} aria-hidden="true">
          {[1, 2, 3].map((n) => (
            <span key={n} className={[s.stepDot, n <= step && s.stepDotOn].filter(Boolean).join(' ')} />
          ))}
        </div>
        <p className="muted">{t('onboarding.step', { n: step })}</p>

        {step === 1 && (
          <>
            <h1 className={s.onboardTitle}>{t('onboarding.nameTitle')}</h1>
            <TextField
              label={t('onboarding.nameTitle')}
              hideLabel
              placeholder={t('onboarding.namePlaceholder')}
              value={form.display_name}
              maxLength={40}
              autoFocus
              error={errors.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            />
            <h2 className="serif" style={{ fontWeight: 500, fontSize: '1.3rem' }}>
              {t('onboarding.languagesTitle')}
            </h2>
            <p className="muted">{t('onboarding.languagesHint')}</p>
            <ChipGroup label={t('onboarding.languagesTitle')} hideLabel>
              {allLangs.map((l) => (
                <Chip key={l} pressed={form.languages.includes(l)} onToggle={() => toggleLang(l)}>
                  {l}
                </Chip>
              ))}
            </ChipGroup>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const name = other.trim();
                if (name && !form.languages.includes(name)) toggleLang(name);
                setOther('');
              }}
            >
              <TextField label={t('onboarding.otherLanguage')} placeholder={t('onboarding.otherPlaceholder')} value={other} maxLength={40} onChange={(e) => setOther(e.target.value)} />
            </form>
            {errors.languages && (
              <p role="alert" style={{ color: 'var(--danger)' }}>
                {t(errors.languages)}
              </p>
            )}
            {form.languages.length > 1 && (
              <div className="row-wrap" role="group" aria-label={t('onboarding.primary')}>
                {form.languages.map((l) => (
                  <span key={l} className="row" style={{ gap: 2 }}>
                    <IconButton
                      aria-label={t('onboarding.makePrimary', { name: l })}
                      aria-pressed={form.primary_language === l}
                      onClick={() => setForm({ ...form, primary_language: l })}
                    >
                      <Star size={16} fill={form.primary_language === l ? 'var(--progress)' : 'none'} color="var(--progress)" />
                    </IconButton>
                    {l}
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h1 className={s.onboardTitle}>{t('onboarding.goalTitle')}</h1>
            <p className="muted">{t('onboarding.goalHint')}</p>
            <div className="row-wrap">
              {[15, 30, 45, 60, 90, 120].map((m) => (
                <Chip key={m} pressed={form.daily_goal_min === m} onToggle={() => setForm({ ...form, daily_goal_min: m })}>
                  {t('common.minutes', { count: m })}
                </Chip>
              ))}
            </div>
            <TextField
              label={t('onboarding.goalLabel')}
              type="number"
              min={5}
              max={720}
              value={form.daily_goal_min}
              error={errors.daily_goal_min}
              onChange={(e) => setForm({ ...form, daily_goal_min: Number(e.target.value) })}
            />
            <TextField
              label={t('onboarding.boundaryLabel')}
              type="time"
              value={form.day_boundary}
              hint={t('onboarding.boundaryHint')}
              error={errors.day_boundary}
              onChange={(e) => setForm({ ...form, day_boundary: e.target.value })}
            />
          </>
        )}

        {step === 3 && (
          <>
            <h1 className={s.onboardTitle}>{t('onboarding.letterTitle')}</h1>
            <p className="serif" style={{ fontSize: '1.15rem' }}>
              {t('onboarding.letterPrompt')}
            </p>
            <TextArea
              label={t('onboarding.letterPrompt')}
              hideLabel
              rows={7}
              hint={t('onboarding.letterHint')}
              placeholder={t('onboarding.letterPlaceholder')}
              value={form.letter ?? ''}
              maxLength={10_000}
              onChange={(e) => setForm({ ...form, letter: e.target.value })}
            />
          </>
        )}

        <div className="row">
          {step > 1 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              {t('common.back')}
            </Button>
          )}
          <span className="spacer" />
          <Button variant="ghost" onClick={() => (step === 3 ? finish({ ...form, letter: null }) : step === 1 ? finish(form) : setStep(step + 1))}>
            {t('common.skip')}
          </Button>
          <Button variant="primary" size="lg" onClick={next} loading={complete.isPending}>
            {step === 3 ? t('onboarding.finish') : t('common.next')}
          </Button>
        </div>
      </Card>
    </main>
  );
}
