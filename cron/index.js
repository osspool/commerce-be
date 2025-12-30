export async function initialize() {
  // Minimal scheduler: run once per month to reduce file churn
  // const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  // const run = async () => {
  //   try {
  //     const now = new Date();
  //     const cutoff = new Date(now.getTime() - 15 * 30 * 24 * 60 * 60 * 1000); // ~15 months
  //     // Upsert a single archive per type globally. You can scope by org/parlour in future using a loop.
  //     await archiveService.runArchive({ type: 'booking', rangeFrom: '1970-01-01', rangeTo: cutoff.toISOString(), ttlDays: 365 });
  //     await archiveService.runArchive({ type: 'transaction', rangeFrom: '1970-01-01', rangeTo: cutoff.toISOString(), ttlDays: 365 });
  //     // Cleanup any expired archives and orphan files
  //     await archiveService.cleanupExpiredAndOrphans();
  //   } catch (e) {
  //     console.error('Archive cron failed:', e);
  //   }
  // };
  // // Initial delay: 6 hours to avoid spike on boot
  // setTimeout(() => {
  //   run();
  //   setInterval(run, MONTH_MS);
  // }, 6 * 60 * 60 * 1000);
  console.log('Archive cron initialized');
}

export default { initialize };


