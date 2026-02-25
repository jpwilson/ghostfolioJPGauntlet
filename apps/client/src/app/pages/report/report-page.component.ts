import { internalRoutes } from '@ghostfolio/common/routes/routes';

import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterModule } from '@angular/router';

@Component({
  host: { class: 'page' },
  imports: [CommonModule, MatButtonModule, RouterModule],
  selector: 'gf-report-page',
  styleUrls: ['./report-page.scss'],
  templateUrl: './report-page.html'
})
export class GfReportPageComponent {
  public routerLinkHome = internalRoutes.home.routerLink;

  public reportTitle = 'Custom Report';
  public reportContent = '';
}
