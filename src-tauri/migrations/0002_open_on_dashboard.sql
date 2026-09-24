-- The app opens on the Dashboard by default (decided 2026-09-25). Nothing was
-- released with the old default, so every stored default moves over.
UPDATE settings SET value = '"dashboard"' WHERE key = 'open_on' AND value = '"today"';
