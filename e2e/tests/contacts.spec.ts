import { expect, login, openTab, test } from "./helpers";

const VCF = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:E2E Mum",
  "TEL;type=CELL:07700 900123",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Smith;E2E John;;;",
  "TEL;type=WORK:+44 20 7946 0958",
  "END:VCARD",
  "",
].join("\r\n");

async function openContacts(page: Parameters<typeof login>[0]) {
  await openTab(page, /Memory/);
  await page.getByRole("radio", { name: "Contacts" }).click();
  await expect(page.getByRole("button", { name: "Add contact" })).toBeVisible();
}

test("imports a vCard, searches, stars, and deletes contacts", async ({ page, account }) => {
  await login(page, account);
  await openContacts(page);
  await page
    .getByLabel("vCard file")
    .setInputFiles({ name: "family.vcf", mimeType: "text/vcard", buffer: Buffer.from(VCF) });
  await expect(page.getByRole("status")).toHaveText(/Imported 2, updated 0\./);
  await expect(page.getByText("+447700900123")).toBeVisible();
  await expect(page.getByText("+442079460958")).toBeVisible();
  await expect(page.getByText("work")).toBeVisible();

  await page.getByLabel("Search contacts").fill("john");
  await expect(page.getByTestId("contact")).toHaveCount(1);
  await expect(page.getByText("E2E John Smith")).toBeVisible();

  await page.getByLabel("Search contacts").fill("");
  await page.getByRole("button", { name: "Favourite E2E Mum" }).click();
  await expect(page.getByRole("button", { name: "Unfavourite E2E Mum" })).toBeVisible();
  await page.getByLabel("Favourites only").click();
  await expect(page.getByTestId("contact")).toHaveCount(1);
  await expect(page.getByText("E2E Mum")).toBeVisible();

  await page.getByRole("button", { name: "Show history of E2E Mum" }).click();
  await expect(page.getByText("No calls or messages yet.")).toBeVisible();
  await page.getByRole("button", { name: "Delete contact" }).click();
  await expect(page.getByText("No contacts match.")).toBeVisible();
});

test("adds a contact by hand with the number normalised, and calling needs Twilio", async ({ page, account }) => {
  await login(page, account);
  await openContacts(page);
  await page.getByRole("button", { name: "Add contact" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Contact name").fill("E2E Dad");
  await dialog.getByLabel("Contact phone").fill("07700 900124");
  await dialog.getByLabel("Contact label").fill("mobile");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("+447700900124")).toBeVisible();
  await expect(page.getByText("mobile")).toBeVisible();

  await page.getByRole("button", { name: "Call E2E Dad" }).click();
  await expect(page.getByRole("status")).toHaveText(/Connect Twilio under Connections first\./);

  await page.getByRole("button", { name: "Help" }).click();
  await expect(page.getByRole("heading", { name: "Import contacts from your phone" })).toBeVisible();
  await expect(page.getByText(/Contact Picker API/)).toBeVisible();
});
