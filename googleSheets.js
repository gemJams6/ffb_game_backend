const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.DRAFT_AVAILABILITY_SHEET_ID;
const SHEET_GID = Number(process.env.DRAFT_AVAILABILITY_GID);

// Sheet row names don't always match the site's canonical player list.
// Left side is what the site calls a player; right side is every name that
// row could appear as in the sheet (checked in order).
const PLAYER_ALIASES = {
  Dan: ["Dan"],
  Grove: ["Grove"],
  Drew: ["Drew"],
  Ed: ["Ed"],
  "Old Guys": ["Old Guys", "Kevin & Johnny"],
  Tyton: ["Tyton"],
  Brian: ["Brian"],
  Jason: ["Jason"],
  Rican: ["Rican"],
  Torelli: ["Torelli"]
};

const ALLOWED_VALUES = ["", "Evening", "All Day", "None But Maybe", "None Can't Budge"];

let sheetsClientPromise = null;

function getSheetsClient() {
  if (!sheetsClientPromise) {
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    sheetsClientPromise = Promise.resolve(google.sheets({ version: "v4", auth }));
  }
  return sheetsClientPromise;
}

async function getSheetTitle(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets.properties"
  });

  const match = meta.data.sheets.find((s) => s.properties.sheetId === SHEET_GID);
  if (!match) {
    throw new Error(`No sheet tab found with gid ${SHEET_GID}`);
  }

  return match.properties.title;
}

// Finds the header row ("Owners:" in column A) and every owner row after it,
// stopping at the first fully blank row. Column count (dates + notes) is
// inferred from the widest row rather than hardcoded, so next year's date
// range shows up automatically as long as the sheet layout stays the same.
function parseAvailabilityBlock(rows) {
  const headerRowIndex = rows.findIndex((row) => (row[0] || "").trim() === "Owners:");
  if (headerRowIndex === -1) {
    throw new Error('Could not find the "Owners:" header row');
  }

  const ownerRows = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (!row.some((cell) => (cell || "").trim())) break;
    ownerRows.push({ sheetRow: i + 1, cells: row });
  }

  const maxLen = Math.max(
    (rows[headerRowIndex] || []).length,
    ...ownerRows.map((r) => r.cells.length)
  );
  const notesColIndex = maxLen - 1;
  const numDateCols = notesColIndex - 1;

  const headerRow = rows[headerRowIndex];
  const dates = [];
  for (let i = 0; i < numDateCols; i++) {
    dates.push(headerRow[i + 1] || "");
  }

  return { dates, notesColIndex, ownerRows, headerSheetRow: headerRowIndex + 1 };
}

function findOwnerRow(ownerRows, playerName) {
  const aliases = PLAYER_ALIASES[playerName] || [playerName];
  return ownerRows.find((row) => aliases.includes((row.cells[0] || "").trim()));
}

async function getAvailability() {
  const sheets = await getSheetsClient();
  const title = await getSheetTitle(sheets);

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${title}'!A1:Z60`
  });

  const rows = result.data.values || [];
  const { dates, notesColIndex, ownerRows } = parseAvailabilityBlock(rows);

  const players = {};
  Object.keys(PLAYER_ALIASES).forEach((playerName) => {
    const row = findOwnerRow(ownerRows, playerName);
    const values = dates.map((_, i) => (row ? row.cells[i + 1] || "" : ""));
    const note = row ? row.cells[notesColIndex] || "" : "";
    players[playerName] = { values, note };
  });

  return { dates, players, sheetTitle: title };
}

async function saveAvailability(playerName, values, note) {
  if (!(playerName in PLAYER_ALIASES)) {
    throw new Error(`Unknown player: ${playerName}`);
  }

  values.forEach((v) => {
    if (!ALLOWED_VALUES.includes(v)) {
      throw new Error(`Invalid availability value: ${v}`);
    }
  });

  const sheets = await getSheetsClient();
  const title = await getSheetTitle(sheets);

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${title}'!A1:Z60`
  });

  const rows = result.data.values || [];
  const { notesColIndex, ownerRows, headerSheetRow } = parseAvailabilityBlock(rows);
  const lastColLetter = columnIndexToLetter(notesColIndex);

  const existingRow = findOwnerRow(ownerRows, playerName);
  const rowValues = [playerName, ...values, note];

  if (existingRow) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${title}'!A${existingRow.sheetRow}:${lastColLetter}${existingRow.sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowValues] }
    });
  } else {
    // Bound the append range to exactly the existing owner-rows block, so the
    // API can't scan past the blank-row gap into the legend/template section
    // further down the sheet and insert the new row in the wrong place.
    const lastOwnerSheetRow = ownerRows.length
      ? ownerRows[ownerRows.length - 1].sheetRow
      : headerSheetRow;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${title}'!A${headerSheetRow}:${lastColLetter}${lastOwnerSheetRow}`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowValues] }
    });
  }
}

function columnIndexToLetter(index) {
  let letter = "";
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

module.exports = { getAvailability, saveAvailability, ALLOWED_VALUES };
