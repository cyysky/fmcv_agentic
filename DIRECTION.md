# Direction from human — build these features

This file carries human direction for the loop. Work on it steadily and patiently,
one committable step at a time, until each item below is done (or until the human
updates or clears this file). Record progress and next steps in ROUND.md.

1. **Managed document buckets.** Support managed documents (PDF, text, video,
   audio) that can be added into different buckets:
   - Bucket names are unique.
   - Buckets are read-only.
   - Each bucket is mapped to either a project folder or an agent folder.
   - A project folder or agent folder can contain many bucket folders.
2. **Cron jobs.** Add the ability to create and manage cron jobs (schedule and
   run recurring tasks).
3. **Agent skills.** Agents must be able to create, install, and use skills.
4. **View HTML.** Add the ability to view HTML by link, or open it in a new tab
   or window.

For each item: plan first, keep changes small and committable, extend tests and
docs, and verify the user journeys before moving on.
