import type { TreatmentOrigin } from './facts';
import type { AssetCheckKind, AssetMethod, DisposalKind } from './assets';
import type { InvoiceCheckKind, InvoiceTreatment, OpenCheckKind, Purpose } from './types';

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
};

export const INVOICE_TREATMENT_LABELS: Record<InvoiceTreatment, string> = {
  small_business: 'Ohne Umsatzsteuer (Kleinunternehmer, § 19)',
  standard: 'Mit Umsatzsteuer, Regelsatz',
  reduced: 'Mit Umsatzsteuer, ermäßigter Satz',
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
        case 'invalid_payment':
          return 'Bitte Datum und Betrag jedes Zahlungseingangs prüfen.';
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
        case 'receipt_without_total':
          return 'Der Beleg hat keinen Betrag; ohne ihn lässt er sich nicht aufteilen.';
        case 'account_label_required':
          return 'Bitte einen Namen für das Konto eingeben.';
        case 'account_label_taken':
          return 'Ein Konto mit diesem Namen gibt es bereits.';
        case 'file_already_imported':
          return 'Genau diese Datei wurde für dieses Konto schon eingelesen. Es wurde nichts doppelt angelegt.';
        case 'unknown_layout':
          return 'Der Aufbau dieser Datei wird nicht erkannt. Unterstützt werden die Exporte von N26, Tomorrow und PayPal (CSV) sowie die Umsatzliste der Bankschnittstelle (JSON). Es wurde nichts eingelesen.';
        case 'empty':
          return 'Die Datei enthält keine Umsätze.';
        case 'too_large':
          return 'Die Datei ist zu groß für einen Kontoexport (mehr als 8 MB).';
        case 'format_mismatch':
          return 'Dieses Konto wurde bisher aus einer anderen Quelle eingelesen. Damit keine Zahlung doppelt entsteht, bleibt ein Konto bei einer Quelle; für die andere Quelle bitte ein eigenes Konto anlegen.';
        case 'batch_has_later_overlap':
          return 'Ein später eingelesener Export deckt dieselben Tage ab. Bitte zuerst den späteren Import rückgängig machen.';
        case 'target_fully_paid':
          return 'Diese Rechnung ist bereits vollständig bezahlt.';
        case 'link_exceeds_payment':
          return 'Der Betrag ist größer als das, was von dieser Zahlung noch nicht zugeordnet ist.';
        case 'invalid_link':
          return 'Diese Zuordnung ist nicht möglich. Bitte Zahlung, Beleg oder Rechnung und Betrag prüfen.';
        case 'invalid_treatment':
          return 'Für diese Gegenseite lässt sich keine Regel anlegen (kein Name).';
        case 'invalid_disposal':
          return 'Bitte Datum, Art und Erlös des Abgangs prüfen. Bei einem Abgang ohne Erlös bleibt der Erlös leer.';
        case 'no_vendor':
          return 'Dieser Beleg hat keinen Lieferanten, für den eine Regel gelten könnte.';
        case 'invalid_date':
          return 'Das Datum „gilt ab“ ist ungültig.';
        default:
          if (detail?.startsWith('unreadable_row:')) {
            return `Zeile ${detail.split(':')[1]} der Datei lässt sich nicht lesen (Datum oder Betrag). Es wurde nichts eingelesen, auch nicht die Zeilen davor.`;
          }
          return 'Eine Eingabe ist ungültig. Bitte die Angaben prüfen.';
      }
    default:
      return 'Das hat nicht geklappt. Bitte erneut versuchen; wenn es wieder scheitert, die Verbindung prüfen.';
  }
}
