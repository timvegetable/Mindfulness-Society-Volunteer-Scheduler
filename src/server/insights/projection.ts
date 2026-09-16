import type {
  InsightAdminProjection,
  InsightAdminProjectionCell,
  InsightDataset,
  InsightProjection,
  InsightProjectionCell,
  OverlapCell,
} from './types.js';

function projectCell(cell: OverlapCell): InsightProjectionCell {
  return {
    weekday: cell.weekday,
    start: cell.start,
    end: cell.end,
    timeZone: cell.timeZone,
    count: cell.count,
    volunteerIds: [...cell.volunteerIds],
  };
}

/**
 * Projects the shared table/heatmap dataset without contact information. The
 * explicit count is retained so clients do not need to infer intensity from
 * color or from the length of the ID list.
 */
export function projectInsight(dataset: InsightDataset): InsightProjection {
  return {
    sourceRevision: { ...dataset.sourceRevision },
    generatedAt: dataset.generatedAt,
    stale: dataset.stale,
    leftoverVolunteerCount: dataset.leftoverVolunteers.length,
    cells: dataset.cells.map(projectCell),
  };
}

/** Administrator-only projection including names but never email addresses. */
export function projectInsightForAdministrator(dataset: InsightDataset): InsightAdminProjection {
  const namesById = new Map(dataset.leftoverVolunteers.map((volunteer) => [volunteer.id, volunteer.name]));
  const cells: InsightAdminProjectionCell[] = dataset.cells.map((cell) => ({
    ...projectCell(cell),
    volunteerNames: cell.volunteerIds.flatMap((volunteerId) => {
      const name = namesById.get(volunteerId);
      return name === undefined ? [] : [name];
    }),
  }));
  return {
    ...projectInsight(dataset),
    cells,
    leftoverVolunteers: dataset.leftoverVolunteers.map((volunteer) => ({ id: volunteer.id, name: volunteer.name, readinessRank: volunteer.readinessRank as 1 | 2 | 3 })),
  };
}

export function projectInsights(dataset: InsightDataset, administrator = false): InsightProjection | InsightAdminProjection {
  return administrator ? projectInsightForAdministrator(dataset) : projectInsight(dataset);
}
