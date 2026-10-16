/**
 * Synthetic electronic invoices for the tests: invented sellers, numbers and
 * figures, written by hand after the public structure of XRechnung (UBL and
 * CII) and Factur-X. No real invoice is used anywhere.
 */

import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, type PDFRef } from 'pdf-lib';

/** A UBL invoice over 100.00 net at 19 % and 50.00 net at 7 %: 119.00 + 53.50 = 172.50. */
export const UBL_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>BSP-2026-0042</cbc:ID>
  <cbc:IssueDate>2026-09-14</cbc:IssueDate>
  <cbc:DueDate>2026-09-28</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:Note>Beispiel &amp; Muster</cbc:Note>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Muster Software</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>DE000000000</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>00/000/00000</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>Muster Software GmbH</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Beispielkunde</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">22.50</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">50.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">3.50</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>7</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">150.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">150.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">172.50</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">172.50</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Lizenz</cbc:Name></cac:Item>
  </cac:InvoiceLine>
</ubl:Invoice>
`;

/** A UBL credit note over 10.00 net at 19 %. */
export const UBL_CREDIT_NOTE = `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>GS-7</cbc:ID>
  <cbc:IssueDate>2026-10-01</cbc:IssueDate>
  <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Muster Software</cbc:Name></cac:PartyName></cac:Party></cac:AccountingSupplierParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">1.90</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">10.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">1.90</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="EUR">10.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">11.90</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">11.90</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</CreditNote>
`;

/** A CII invoice (XRechnung in CII syntax, or the XML of a Factur-X PDF) over 200.00 net at 19 %, 50.00 prepaid. */
export const CII_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>RE-2026-913</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20261002</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem><ram:SpecifiedTradeProduct><ram:Name>Hosting</ram:Name></ram:SpecifiedTradeProduct></ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Beispiel Hosting AG</ram:Name>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE111111111</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty><ram:Name>Beispielkunde</ram:Name></ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>38.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>200.00</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime><udt:DateTimeString format="102">20261016</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>200.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>200.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">38.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>238.00</ram:GrandTotalAmount>
        <ram:TotalPrepaidAmount>50.00</ram:TotalPrepaidAmount>
        <ram:DuePayableAmount>188.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;

/** A one-page PDF that prints something else than its XML says, with `xml` embedded under `name` (as Factur-X does). */
export async function pdfWithEmbeddedXml(xml: string | null, name = 'factur-x.xml'): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 300]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Rechnung Gesamt 999,99 EUR', { x: 20, y: 250, size: 12, font });
  if (xml !== null) await document.attach(new TextEncoder().encode(xml), name, { mimeType: 'text/xml', description: 'Factur-X' });
  return document.save();
}

/** How a hand-built PDF stores its embedded files. */
export interface EmbeddingLayout {
  files: Array<{ name: string; bytes: Uint8Array; compress?: boolean; declaredSize?: number }>;
  /** 'flat': Names array on the root of the tree; 'kids': one level of Kids; 'af': only the catalog's AF array; 'loop': a Kids array that points back at itself. */
  tree: 'flat' | 'kids' | 'af' | 'loop';
  /** Every file entry points at the first file's stream (a fan-out of one bomb). */
  shareStream?: boolean;
  /** Mark the document as encrypted (an /Encrypt entry in the trailer). */
  encrypted?: boolean;
}

/** A PDF built object by object, to test the paths `document.attach` never writes. */
export async function pdfWithLayout(layout: EmbeddingLayout): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  const { context } = document;
  let shared: PDFRef | null = null;
  const specs: Array<{ name: string; ref: PDFRef }> = layout.files.map((file) => {
    const streamDict: Record<string, unknown> = { Type: 'EmbeddedFile', Subtype: 'text/xml' };
    if (file.declaredSize !== undefined) streamDict.Params = { Size: file.declaredSize };
    const makeStream = () => (file.compress === false ? context.stream(file.bytes, streamDict as never) : context.flateStream(file.bytes, streamDict as never));
    const streamRef = layout.shareStream && shared ? shared : context.register(makeStream());
    shared ??= streamRef;
    const spec = context.obj({ Type: 'Filespec', F: PDFString.of(file.name), UF: PDFHexString.fromText(file.name), EF: { F: streamRef, UF: streamRef }, AFRelationship: 'Alternative' });
    return { name: file.name, ref: context.register(spec) };
  });
  const namesArray = specs.flatMap((s) => [PDFString.of(s.name), s.ref]);
  if (layout.tree === 'af') {
    document.catalog.set(PDFName.of('AF'), context.obj(specs.map((s) => s.ref)));
  } else if (layout.tree === 'flat') {
    document.catalog.set(PDFName.of('Names'), context.obj({ EmbeddedFiles: { Names: namesArray } }));
  } else {
    const leaf = context.register(context.obj({ Names: namesArray }));
    const root = context.obj({ Kids: [leaf] });
    const rootRef = context.register(root);
    if (layout.tree === 'loop') {
      // Fifty references back to the root itself: walked naively this is 50 to the power of the depth.
      const loop = context.obj(Array.from({ length: 50 }, () => rootRef));
      root.set(PDFName.of('Kids'), context.obj([leaf, ...loop.asArray()]));
    }
    document.catalog.set(PDFName.of('Names'), context.obj({ EmbeddedFiles: rootRef }));
  }
  if (layout.encrypted) context.trailerInfo.Encrypt = context.register(context.obj({ Filter: 'Standard', V: 2, R: 3 }));
  return document.save({ useObjectStreams: false });
}
