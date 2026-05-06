import { page } from "@fresh/core";
import {
  deleteOrphanMedia,
  getOrphanMediaStatus,
} from "@hackerspub/models/admin";
import { AdminNav } from "../../components/AdminNav.tsx";
import { Button } from "../../components/Button.tsx";
import { db } from "../../db.ts";
import { drive } from "../../drive.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(_ctx) {
    return page<MediaMaintenanceProps>({
      status: await getOrphanMediaStatus(db),
    });
  },

  async POST(_ctx) {
    const result = await deleteOrphanMedia(db, drive.use());
    return page<MediaMaintenanceProps>({
      status: await getOrphanMediaStatus(db),
      deletedCount: result.deletedCount,
      failedDiskDeletes: result.failedDiskDeletes,
    });
  },
});

interface MediaMaintenanceProps {
  status: {
    cutoffDate: Date;
    orphanMediaCount: number;
  };
  deletedCount?: number;
  failedDiskDeletes?: number;
}

export default define.page<typeof handler, MediaMaintenanceProps>(
  function MediaMaintenance({ state: { language }, data }) {
    const { status, deletedCount, failedDiskDeletes } = data;

    return (
      <div>
        <AdminNav active="media" />

        <div class="mb-6">
          <p class="mb-4">
            This removes media created before{" "}
            {status.cutoffDate.toLocaleString(language)}{" "}
            that are not attached to an avatar, note, article draft, or article.
          </p>

          {deletedCount != null && (
            <div class="bg-green-100 dark:bg-green-900 p-4 rounded mb-4">
              <p>
                Deleted {deletedCount.toLocaleString(language)} orphan media.
              </p>
              {failedDiskDeletes != null && failedDiskDeletes > 0 && (
                <p>
                  Failed to delete {failedDiskDeletes.toLocaleString(language)}
                  {" "}
                  disk objects.
                </p>
              )}
            </div>
          )}

          <p class="mb-4">
            {status.orphanMediaCount.toLocaleString(language)}{" "}
            orphan media can be deleted.
          </p>

          <form method="POST">
            <Button type="submit" disabled={status.orphanMediaCount < 1}>
              Delete Orphan Media
            </Button>
          </form>
        </div>
      </div>
    );
  },
);
