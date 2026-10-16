import { formatCents } from './money';
import type { TreatmentOrigin } from './facts';
import type { AssetCheckKind, AssetMethod, DisposalKind } from './assets';
import type { InvoiceCheckKind, InvoiceTreatment, OpenCheckKind, Purpose } from './types';
import { REMINDER_AFTER_DAYS } from './overdue';

/** German wording for the finance screens, in one place. */

export const CHECK_LABELS: Record<OpenCheckKind, string> = {
  no_date: 'Datum fehlt',
  no_amount: 'Betrag fehlt',
  no_exchange_rate: 'Wechselkurs fehlt',
  amount_estimated: 'Betrag geschätzt (Referenzkurs, noch keine Zahlung zugeordnet)',
  no_allocation: 'Noch nicht entschieden, wer die Kosten trägt',
  allocation_exceeds_whole: 'Anteile ergeben mehr als 100 %',
  no_form_line: 'Zeile der EÜR fehlt',
  no_employment_line: 'Zeile der Anlage N fehlt',
  small_business_unanswered: 'Frage zur Kleinunternehmerregelung offen',
  net_amount_missing: 'Nettobetrag fehlt (unter Regelbesteuerung zählt der Nettobetrag, die Umsatzsteuer ist Vorsteuer)',
  meal_incomplete: 'Bewirtung unvollständig (Teilnehmer, Anlass oder Ort fehlen)',
  meal_without_register_facts: 'Bewirtung ohne Angaben aus dem Verzeichnis',
  lines_do_not_sum: 'Die Positionen ergeben nicht mehr den Belegbetrag',
  needs_asset: 'Über der Grenze für geringwertige Wirtschaftsgüter: als Anlage führen',
  net_amount_needed: 'Nettobetrag fehlt: nahe an der Grenze für geringwertige Wirtschaftsgüter',
  net_does_not_fit: 'Nettobetrag passt nicht zum Bruttobetrag (größer als dieser oder mit anderem Vorzeichen): bitte im Beleg korrigieren',
  credit_note_payment_out:
    'Rechnungskorrektur (Gutschrift) mit zugeordneter Ausgabe: bitte unter „Zahlungen“ prüfen und die Ausgabe der Rechnung zuordnen, mit der die Gutschrift verrechnet wurde',
  credit_note_on_meal_line:
    'Rechnungskorrektur (Gutschrift) auf der Zeile für Bewirtungen: das Bewirtungsverzeichnis führt keine Gutschriften. Bitte die Bewirtung im Verzeichnis berichtigen und hier eine andere Zeile wählen oder „Privat“',
  credit_note_status_review:
    'Rechnungskorrektur (Gutschrift) nach einem Wechsel bei der Kleinunternehmerregelung: gerechnet wird mit dem Status am Tag der Korrektur. Galt für den ursprünglichen Einkauf der andere Status, folgt die Korrektur diesem (§ 17 Umsatzsteuergesetz): dann in der Voranmeldung die Vorsteuer nicht berichtigen (Einkauf unter § 19) oder berichtigen (Einkauf unter Regelbesteuerung) und den Betrag in der Einnahmenüberschussrechnung entsprechend brutto oder netto ansetzen',
};

export const ASSET_CHECK_LABELS: Record<AssetCheckKind, string> = {
  asset_no_date: 'Anschaffungsdatum fehlt',
  asset_no_cost: 'Kein Beleg mit Betrag zugeordnet (Beleg fehlt oder hat keinen Betrag)',
  asset_small_business_unanswered: 'Frage zur Kleinunternehmerregelung offen',
  asset_input_tax_correction_review: 'Unter anderem Umsatzsteuerstatus angeschafft: eine Vorsteuerberichtigung kann nötig sein (mit Steuerberater klären)',
  asset_net_unknown: 'Nettobetrag fehlt: die Grenze lässt sich aus dem Bruttobetrag nicht sicher entscheiden',
  asset_low_value_over_limit: 'Über der Grenze für geringwertige Wirtschaftsgüter: andere Methode wählen',
  asset_pool_out_of_range: 'Außerhalb der Grenzen für den Sammelposten',
  asset_no_useful_life: 'Nutzungsdauer fehlt (mehr als ein Jahr)',
  asset_declining_not_allowed: 'Degressive Abschreibung ist für dieses Anschaffungsdatum oder diese Art nicht zulässig',
  asset_declining_rate_too_high: 'Satz der degressiven Abschreibung fehlt oder liegt über dem zulässigen Höchstsatz',
  asset_opening_method: 'Übernommene Anlagen werden linear über die Restnutzungsdauer abgeschrieben',
  asset_opening_no_life: 'Buchwert über dem Erinnerungswert, aber keine Restnutzungsdauer: so würde nie abgeschrieben',
  asset_disposal_before_acquisition: 'Abgang liegt vor der Anschaffung',
  asset_annex_line_unknown: 'Anteil für Studium oder Anstellung ohne gültige Zeile der Anlage N: bitte die Anlage öffnen und die Zeile wählen',
};

export const ASSET_METHOD_LABELS: Record<AssetMethod, string> = {
  low_value: 'Geringwertiges Wirtschaftsgut, sofort abziehen',
  pool: 'Sammelposten, über fünf Jahre auflösen',
  linear: 'Linear über die Nutzungsdauer',
  computer_one_year: 'Computerhardware oder Software, ein Jahr',
  declining: 'Degressiv (fester Satz vom Restwert)',
};

export const DISPOSAL_LABELS: Record<DisposalKind, string> = {
  sold: 'Verkauft',
  scrapped: 'Ausgeschieden ohne Erlös',
  private: 'Ins Privatvermögen übernommen',
};

export const INVOICE_CHECK_LABELS: Record<InvoiceCheckKind, string> = {
  invoice_treatment_mismatch:
    'Ausweis der Umsatzsteuer passt nicht zum Status am Rechnungsdatum (ausgewiesene Steuer wird geschuldet, auch wenn sie zu Unrecht ausgewiesen ist)',
  invoice_no_date: 'Rechnungsdatum fehlt',
  invoice_overpaid: 'Mehr erhalten als der Rechnungsbetrag',
  invoice_overdue: `Überfällig: ${REMINDER_AFTER_DAYS} Tage oder länger nach Fälligkeit noch nicht ganz bezahlt`,
  invoice_tax_groups_unreadable:
    'Die Beträge je Steuersatz sind nicht mehr lesbar; die Steuer zählt, wird aber keinem Satz zugeordnet. Bitte die Rechnung öffnen und die Sätze neu eintragen',
  invoice_tax_group_deviates: 'Die ausgewiesene Steuer eines Satzes weicht um mehr als einen Cent von Netto mal Satz ab; gerechnet wird mit dem Betrag der Rechnung',
};

export const INVOICE_TREATMENT_LABELS: Record<InvoiceTreatment, string> = {
  small_business: 'Ohne Umsatzsteuer (Kleinunternehmer, § 19)',
  standard: 'Mit Umsatzsteuer, Regelsatz',
  reduced: 'Mit Umsatzsteuer, ermäßigter Satz',
  mixed: 'Mit Umsatzsteuer, mehrere Steuersätze',
  not_taxable: 'Ohne Umsatzsteuer (steuerfrei, nicht steuerbar oder Steuerschuld beim Kunden)',
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
  business: 'Betrieb',
  study: 'Studium',
  employment: 'Anstellung',
  private: 'Privat',
};

export const ORIGIN_LABELS: Record<TreatmentOrigin, string> = {
  item: 'für diesen Beleg entschieden',
  vendor_rule: 'Regel für den Lieferanten',
  legacy_columns: 'aus Zuordnung und Geschäftsanteil des Belegs',
  category_default: 'Vorgabe der Kategorie',
  line: 'für diese Position entschieden',
  meal_register: 'laut Bewirtungsverzeichnis',
};

/** Wording for the error codes the finance server actions return. */
export function financeActionMessage(error: string, detail?: string): string {
  switch (error) {
    case 'unauthorized':
      return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und erneut anmelden.';
    case 'forbidden':
      return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Speichern.';
    case 'not_found':
      return detail === 'rule_not_found'
        ? 'Diese Regel gibt es nicht mehr. Die Ansicht wurde vermutlich in einem anderen Fenster geändert; bitte neu laden.'
        : detail === 'boundary_subject_not_found'
          ? 'Diese Zahlung gibt es nicht mehr. Die Ansicht wurde vermutlich in einem anderen Fenster geändert; bitte neu laden.'
        : detail === 'line_not_found'
          ? 'Diese Position gibt es nicht mehr. Die Ansicht wurde vermutlich in einem anderen Fenster geändert; bitte neu laden.'
        : detail === 'asset_not_found'
          ? 'Diese Anlage gibt es nicht mehr. Die Ansicht wurde vermutlich in einem anderen Fenster geändert; bitte neu laden.'
        : 'Dieser Beleg wurde nicht gefunden. Er wurde möglicherweise gelöscht oder gehört zu einem anderen Arbeitsbereich.';
    case 'not_initialized':
      return 'Die Belegtabelle ist noch nicht angelegt. Bitte das Dashboard einmal öffnen und dann erneut versuchen.';
    case 'invalid_input':
      switch (detail) {
        case 'allocation_exceeds_whole':
          return 'Die Anteile ergeben zusammen mehr als 100 %.';
        case 'nothing_allocated':
          return 'Bitte mindestens einen Anteil angeben. Für einen rein privaten Beleg „Privat“ wählen.';
        case 'form_line_required':
          return 'Für den betrieblichen Anteil bitte eine Zeile der EÜR wählen.';
        case 'employment_line_required':
          return 'Für den Anteil Studium oder Anstellung bitte eine Zeile der Anlage N wählen.';
        case 'meal_row':
          return 'Bewirtungen werden im Bewirtungsverzeichnis erfasst, nicht hier.';
        case 'assignment_columns_missing':
          return 'In der Belegtabelle fehlt die Spalte „Zuordnung“ oder „Business Share %“, oder eine ihrer Auswahlen „Geschäftlich“, „Universität“, „Privat“ wurde umbenannt. Bitte dort wiederherstellen, dann speichern.';
        case 'asset_row':
          return 'Dieser Beleg gehört zu einer Anlage. Was abgezogen wird, bestimmt die Anlage.';
        case 'row_in_other_asset':
          return 'Ein ausgewählter Beleg gehört bereits zu einer anderen Anlage.';
        case 'label_required':
          return 'Bitte eine Bezeichnung für die Anlage eingeben.';
        case 'label_too_long':
          return 'Die Bezeichnung ist zu lang.';
        case 'date_required':
        case 'invalid_date':
          return 'Bitte ein gültiges Anschaffungsdatum eingeben.';
        case 'invalid_useful_life':
          return 'Bitte die Nutzungsdauer in ganzen Jahren oder Monaten eingeben.';
        case 'invalid_rate':
          return 'Bitte den Satz der degressiven Abschreibung in Prozent eingeben.';
        case 'invalid_annex_share':
          return 'Bitte den Anteil für Studium oder Anstellung prüfen: zusammen mit dem betrieblichen Anteil höchstens 100 %, mit einer Zeile der Anlage N, und weder beim Sammelposten noch bei degressiver Abschreibung (Arbeitsmittel werden linear abgeschrieben).';
        case 'invalid_reverse_charge_rate':
          return 'Bitte 19 % oder 7 % wählen, oder „kein § 13b“.';
        case 'invalid_reverse_charge_date':
          return 'Das Datum „gilt ab“ ist ungültig.';
        case 'invalid_share':
          return 'Der betriebliche Anteil muss zwischen 1 und 100 % liegen.';
        case 'receipts_required':
          return 'Bitte mindestens einen Beleg zuordnen: die Anschaffungskosten sind die Summe der Belege.';
        case 'receipts_and_opening':
          return 'Eine übernommene Anlage hat einen Buchwert und keine Belege, sonst würden die Kosten doppelt zählen.';
        case 'invalid_opening':
          return 'Bitte Jahr, Buchwert und Restnutzungsdauer der übernommenen Anlage prüfen.';
        case 'number_required':
          return 'Bitte die Rechnungsnummer eingeben.';
        case 'number_too_long':
          return 'Die Rechnungsnummer ist zu lang.';
        case 'invoice_number_taken':
          return 'Diese Rechnungsnummer gibt es bereits.';
        case 'invalid_amount':
          return 'Bitte den Rechnungsbetrag als Betrag größer als null eingeben.';
        case 'invalid_vat':
          return 'Bitte die enthaltene Umsatzsteuer prüfen: bei einer Rechnung mit Umsatzsteuer größer als null und kleiner als der Rechnungsbetrag.';
        case 'vat_without_treatment':
          return 'Eine Rechnung ohne Umsatzsteuer kann keinen Steuerbetrag enthalten.';
        case 'invalid_tax_groups':
          return 'Bitte die Steuersätze prüfen: je Satz (19 % und 7 %) ein Nettobetrag und die Steuer darauf, zusammen genau der Rechnungsbetrag und die enthaltene Umsatzsteuer.';
        case 'invalid_payment':
          return 'Bitte Datum und Betrag jedes Zahlungseingangs prüfen.';
        case 'invalid_write_off':
          return 'Bitte den ausgebuchten Betrag prüfen: mit Datum, und nicht mehr als nach allen Zahlungseingängen noch offen ist.';
        case 'invalid_year':
          return 'Bitte das Jahr prüfen, in dem die Rechnung bereits erklärt wurde.';
        case 'year_boundary_changed':
          return 'Diese Zahlung wurde inzwischen geändert (anderer Zahlungstag oder bereits beantwortet). Die Ansicht wurde neu geladen; bitte noch einmal ansehen und dann antworten.';
        case 'not_in_year_boundary':
          return 'Diese Zahlung liegt nicht (mehr) zwischen dem 22. Dezember und dem 10. Januar; die Ausnahme zum Jahreswechsel gilt für sie nicht. Bitte die Ansicht neu laden.';
        case 'status_unanswered':
          return 'Zuerst muss die Frage zur Kleinunternehmerregelung beantwortet sein (im Bewirtungsverzeichnis unter „Verzeichnis“).';
        case 'invalid_status':
          return 'Bitte ein gültiges Datum für die Statusänderung eingeben.';
        case 'invalid_vat_settings':
          return 'Bitte Abgabezeitraum und Besteuerungsart wählen.';
        case 'invalid_settlement':
          return 'Bitte Datum und Betrag der Zahlung prüfen.';
        case 'invalid_expectation':
          return 'Bitte den erwarteten Monatsumsatz als Betrag eingeben.';
        case 'lines_required':
          return 'Eine Aufteilung braucht mindestens zwei Positionen.';
        case 'lines_do_not_sum':
          return 'Die Positionen ergeben zusammen nicht den Belegbetrag.';
        case 'line_description_required':
          return 'Bitte jede Position benennen.';
        case 'invalid_line_amount':
          return 'Bitte für jede Position einen Betrag größer als null eingeben.';
        case 'invalid_line_net':
          return 'Der Nettobetrag einer Position muss größer als null und höchstens so groß wie ihr Betrag sein.';
        case 'line_cannot_hold_several_items':
          return 'Eine einzelne Position kann nicht „mehrere kleine Teile“ sein; dafür den Beleg weiter aufteilen.';
        case 'credit_note_not_split':
          return 'Eine Rechnungskorrektur (Gutschrift) wird nicht in Positionen aufgeteilt; ihre Behandlung gilt für den ganzen Beleg.';
        case 'receipt_without_total':
          return 'Der Beleg hat keinen Betrag; ohne ihn lässt er sich nicht aufteilen.';
        case 'account_label_required':
          return 'Bitte einen Namen für das Konto eingeben.';
        case 'account_label_taken':
          return 'Ein Konto mit diesem Namen gibt es bereits.';
        case 'file_already_imported':
          return 'Genau diese Datei wurde für dieses Konto schon eingelesen. Es wurde nichts doppelt angelegt.';
        case 'unknown_layout':
          return 'Der Aufbau dieser Datei wird nicht erkannt. Unterstützt werden die Exporte von N26, Tomorrow und PayPal (CSV), die Kaufliste von Klarna (CSV) sowie die Umsatzliste der Bankschnittstelle (JSON). Es wurde nichts eingelesen.';
        case 'empty':
          return 'Die Datei enthält keine Umsätze.';
        case 'too_large':
          return 'Die Datei ist zu groß für einen Kontoexport (mehr als 8 MB).';
        case 'invalid_import_year':
          return 'Das gewählte Jahr ist ungültig. Bitte die Seite neu laden.';
        case 'format_mismatch':
          return 'Die Liste eines Zahlungsdienstes (PayPal, Klarna) und ein Bankexport gehören nicht in dasselbe Konto: sie enthalten verschiedene Buchungen. Für die andere Quelle bitte ein eigenes Konto anlegen. Ein Bankkonto lässt sich dagegen aus einer zweiten Bankquelle fortsetzen.';
        case 'nothing_in_year':
          return 'In dieser Datei liegt keine Zahlung aus dem gewählten Jahr. Es wurde nichts eingelesen.';
        case 'nothing_uncovered':
          return 'Alle Zahlungen dieser Datei hat schon eine andere Quelle dieses Kontos. Es wurde nichts eingelesen. Soll diese Datei die Tage übernehmen, bitte zuerst den Import der anderen Quelle rückgängig machen.';
        case 'nothing_new':
          return 'Die Zahlungen dieses Jahres aus der Datei sind alle schon eingelesen. Es wurde nichts angelegt.';
        case 'batch_has_later_cancellation':
          return 'Ein später eingelesener Import betrifft stornierte Käufe dieses Imports. Bitte zuerst den späteren Import rückgängig machen.';
        case 'batch_has_later_source':
          return 'Später wurde dieses Konto aus einer anderen Quelle fortgesetzt; sie hat die Tage dieses Imports ausgelassen. Bitte zuerst den späteren Import rückgängig machen, sonst fehlen diese Tage.';
        case 'batch_has_later_overlap':
          return 'Ein später eingelesener Export deckt dieselben Tage ab. Bitte zuerst den späteren Import rückgängig machen.';
        case 'proposal_gone':
          return 'Dieser Vorschlag gilt nicht mehr: Zahlung oder Beleg wurde inzwischen zugeordnet. Die Liste ist jetzt aktuell.';
        case 'target_written_off':
          return 'Der Rest dieser Rechnung ist als nicht mehr zu zahlen ausgebucht. Hat die Kundschaft doch gezahlt, zuerst die Ausbuchung an der Rechnung zurücknehmen.';
        case 'target_fully_paid':
          return 'Diese Rechnung ist bereits vollständig bezahlt.';
        case 'link_exceeds_payment':
          return 'Der Betrag ist größer als das, was von dieser Zahlung noch nicht zugeordnet ist.';
        case 'invalid_link':
          return 'Diese Zuordnung ist nicht möglich. Bitte Zahlung, Beleg oder Rechnung und Betrag prüfen.';
        case 'invalid_query':
          return 'Die Suche braucht ein Jahr. Bitte die Seite neu laden.';
        case 'invalid_private':
          return 'Bitte nur „privat“ oder „wieder prüfen“ wählen.';
        case 'invalid_treatment':
          return 'Für diese Gegenseite lässt sich keine Regel anlegen (kein Name).';
        case 'invalid_disposal':
          return 'Bitte Datum, Art und Erlös des Abgangs prüfen. Bei einem Abgang ohne Erlös bleibt der Erlös leer.';
        case 'no_vendor':
          return 'Dieser Beleg hat keinen Lieferanten, für den eine Regel gelten könnte.';
        case 'invalid_date':
          return 'Das Datum „gilt ab“ ist ungültig.';
        default:
          if (detail?.startsWith('refund_exceeds_receipt:')) {
            const left = Number(detail.split(':')[1]);
            if (!(left > 0)) return 'Dieser Beleg ist schon vollständig erstattet. Bitte einen anderen Beleg wählen.';
            return `Diese Erstattung ist größer als das, was der Beleg noch kostet (${formatCents(left)}). Bitte einen Teilbetrag zuordnen oder einen anderen Beleg wählen.`;
          }
          if (detail?.startsWith('unreadable_row:')) {
            return `Zeile ${detail.split(':')[1]} der Datei lässt sich nicht lesen (Datum oder Betrag). Es wurde nichts eingelesen, auch nicht die Zeilen davor.`;
          }
          return 'Eine Eingabe ist ungültig. Bitte die Angaben prüfen.';
      }
    default:
      return 'Das hat nicht geklappt. Bitte erneut versuchen; wenn es wieder scheitert, die Verbindung prüfen.';
  }
}
