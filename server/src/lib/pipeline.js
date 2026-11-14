const STAGES = ["lead", "documents", "applied", "admitted", "visa", "arrived"];

// Parents mostly read Uzbek or Russian; the parent page and Telegram use these.
const STAGE_LABELS = {
  en: { lead: "First contact", documents: "Collecting documents", applied: "Applied", admitted: "Admitted", visa: "Visa", arrived: "Arrived in Korea" },
  uz: { lead: "Birinchi aloqa", documents: "Hujjatlar yig'ilmoqda", applied: "Ariza topshirildi", admitted: "Qabul qilindi", visa: "Viza", arrived: "Koreyaga yetib keldi" },
  ru: { lead: "Первый контакт", documents: "Сбор документов", applied: "Заявка подана", admitted: "Зачислен", visa: "Виза", arrived: "Прибыл в Корею" },
};

const APP_STATUSES = ["draft", "submitted", "review", "admitted", "waitlisted", "declined"];

// Is this university blocked for the given visa track?
function restrictionFor(uni, programType) {
  if (!uni || uni.ieqas_status !== "restricted") return null;
  if (uni.restricted_until && new Date(uni.restricted_until + "T23:59:59Z") < new Date()) return null;
  const p = uni.restricted_programs || "all";
  if (p === "all" || p === programType) {
    const visa = programType === "language" ? "D-4" : "D-2";
    return `${uni.name} is on the Korean visa-restriction list for ${visa} (${p === "all" ? "all" : p} programs)` +
      (uni.restricted_until ? ` until ${uni.restricted_until}` : "") + ".";
  }
  return null;
}

module.exports = { STAGES, STAGE_LABELS, APP_STATUSES, restrictionFor };
